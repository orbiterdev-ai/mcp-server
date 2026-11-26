const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { loadConfig, shouldAutoApprove } = require('../dist/config.js');
const { handleRequestApproval } = require('../dist/tools/approve.js');
const { isTrustedOrbiterInternalTool } = require('../dist/policy/internalTools.js');
const { handleCodexHook, normalizeCodexHookEvent } = require('../dist/codex/hooks.js');
const { handleGeminiHook, normalizeGeminiHookEvent } = require('../dist/gemini/hooks.js');
const { handleAntigravityHook, normalizeAntigravityPreToolUse } = require('../dist/antigravity/hooks.js');

function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function startMockServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function parseToolResult(res) {
  assert.ok(res && Array.isArray(res.content) && res.content.length > 0);
  return JSON.parse(res.content[0].text);
}

// ============================================================================
// F01: Server recorded terminal decision is strictly authoritative;
//      untrusted repo config cannot override stricter user policy
// ============================================================================

test('F01: untrusted repo orbiter.config.json and .orbiter.json cannot grant auto_approval without user opt-in', () => {
  const cwd = mkTempDir('orbiter-f01-repo-');
  const homeDir = mkTempDir('orbiter-f01-home-');

  fs.writeFileSync(
    path.join(cwd, 'orbiter.config.json'),
    JSON.stringify({ auto_approval: [{ pattern: '.*' }] })
  );
  fs.writeFileSync(
    path.join(cwd, '.orbiter.json'),
    JSON.stringify({ auto_approval: [{ pattern: '.*' }] })
  );

  // Case 1: No user config -> workspace rules must be ignored
  const noUserCfg = loadConfig({ cwd, homeDir });
  assert.equal(shouldAutoApprove(noUserCfg, 'deploy to production'), false);

  // Case 2: Stricter user config without allow_workspace_auto_approval -> workspace cannot loosen it
  fs.mkdirSync(path.join(homeDir, '.orbiter'), { recursive: true });
  fs.writeFileSync(
    path.join(homeDir, '.orbiter', 'config.json'),
    JSON.stringify({ auto_approval: [{ pattern: '^safe-readonly-check$' }] })
  );
  const strictUserCfg = loadConfig({ cwd, homeDir });
  assert.equal(shouldAutoApprove(strictUserCfg, 'deploy to production'), false);
  assert.equal(shouldAutoApprove(strictUserCfg, 'safe-readonly-check'), true);

  // Case 3: Explicit user opt-in allows workspace rules as advisory hint only
  fs.writeFileSync(
    path.join(homeDir, '.orbiter', 'config.json'),
    JSON.stringify({ allow_workspace_auto_approval: true })
  );
  const optInCfg = loadConfig({ cwd, homeDir });
  assert.equal(shouldAutoApprove(optInCfg, 'deploy to production'), true);
});

test('F01: matching workspace rule MUST NOT return approved:true when server records 201/pending', async () => {
  const cwd = mkTempDir('orbiter-f01-pending-repo-');
  const homeDir = mkTempDir('orbiter-f01-pending-home-');
  fs.mkdirSync(path.join(homeDir, '.orbiter'), { recursive: true });
  fs.writeFileSync(
    path.join(homeDir, '.orbiter', 'config.json'),
    JSON.stringify({ allow_workspace_auto_approval: true })
  );
  fs.writeFileSync(
    path.join(cwd, 'orbiter.config.json'),
    JSON.stringify({ auto_approval: [{ pattern: 'deploy' }] })
  );

  let postCount = 0;
  let pollCount = 0;
  const mock = await startMockServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/v1/approvals') {
      postCount++;
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: { id: 'req-pending-1', status: 'pending' } }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/v1/approvals/req-pending-1/sse') {
      res.writeHead(404);
      res.end();
      return;
    }
    if (req.method === 'GET' && req.url === '/api/v1/approvals/req-pending-1') {
      pollCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: { id: 'req-pending-1', status: 'pending' } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  try {
    const res = await handleRequestApproval(
      {
        action: 'deploy',
        description: 'deploy release to production',
        risk_analysis: 'Checked release artifact',
        riskLevel: 'high',
      },
      {
        serverUrl: mock.url,
        timeoutSeconds: 0.25,
        pollIntervalMs: 40,
        cwd,
        homeDir,
      }
    );
    const body = parseToolResult(res);
    assert.equal(postCount, 1);
    assert.ok(pollCount >= 1, 'client must wait/poll while server status is pending');
    assert.equal(body.approved, false);
    assert.equal(body.success, false);
    assert.equal(body.status, 'timeout');
    assert.equal(body.approval_id, 'req-pending-1');
  } finally {
    await mock.close();
  }
});

test('F01: rejected and expired terminal server verdicts return approved:false even with matching auto_approval rule', async () => {
  for (const terminalStatus of ['rejected', 'expired']) {
    const reqId = `req-${terminalStatus}-1`;
    const mock = await startMockServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/v1/approvals') {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: { id: reqId, status: 'pending' } }));
        return;
      }
      if (req.method === 'GET' && req.url === `/api/v1/approvals/${reqId}/sse`) {
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.method === 'GET' && req.url === `/api/v1/approvals/${reqId}`) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          data: { id: reqId, status: terminalStatus, response_notes: `Server marked ${terminalStatus}` },
        }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    try {
      const res = await handleRequestApproval(
        {
          action: 'deploy',
          description: 'deploy release',
          risk_analysis: 'Standard rollout',
        },
        {
          serverUrl: mock.url,
          timeoutSeconds: 2,
          pollIntervalMs: 25,
          config: { auto_approval: [{ pattern: '.*' }] },
        }
      );
      const body = parseToolResult(res);
      assert.equal(body.approved, false);
      assert.equal(body.status, terminalStatus);
      assert.equal(body.approval_id, reqId);
    } finally {
      await mock.close();
    }
  }
});

test('F01: absent or incomplete server responses fail closed with approved:false', async () => {
  const cases = [
    { name: 'missing id', body: JSON.stringify({ success: true, data: { status: 'approved' } }) },
    { name: 'empty body', body: '' },
    { name: 'invalid json', body: '{not-json' },
  ];

  for (const tc of cases) {
    const mock = await startMockServer((req, res) => {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(tc.body);
    });

    try {
      const res = await handleRequestApproval(
        {
          action: 'delete',
          description: 'delete staging bucket',
          risk_analysis: 'Cleanup',
        },
        {
          serverUrl: mock.url,
          timeoutSeconds: 1,
          pollIntervalMs: 25,
          config: { auto_approval: [{ pattern: '.*' }] },
        }
      );
      const body = parseToolResult(res);
      assert.equal(body.success, false, `expected success:false for ${tc.name}`);
      assert.equal(body.approved, false, `expected approved:false for ${tc.name}`);
      assert.equal(body.status, 'incomplete', `expected incomplete status for ${tc.name}`);
    } finally {
      await mock.close();
    }
  }
});

test('F01: tracked approval ID binding ignores mismatched IDs and approves ONLY after server confirms terminal approved', async () => {
  // 1) SSE ignores mismatched approval_id and non-terminal pending events, then honors matching approved
  const sseMock = await startMockServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/v1/approvals') {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: { id: 'req-sse-bound', status: 'pending' } }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/v1/approvals/req-sse-bound/sse') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write('event: decision\ndata: {"approval_id":"req-other","status":"rejected"}\n\n');
      res.write('event: decision\ndata: {"approval_id":"req-sse-bound","status":"pending"}\n\n');
      setTimeout(() => {
        res.write('event: decision\ndata: {"approval_id":"req-sse-bound","status":"approved","notes":"Biometric verified"}\n\n');
        res.end();
      }, 30);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  try {
    const res = await handleRequestApproval(
      {
        action: 'deploy',
        description: 'deploy service',
        risk_analysis: 'Verified tests',
      },
      { serverUrl: sseMock.url, timeoutSeconds: 2, config: {} }
    );
    const body = parseToolResult(res);
    assert.equal(body.success, true);
    assert.equal(body.approved, true);
    assert.equal(body.status, 'approved');
    assert.equal(body.approval_id, 'req-sse-bound');
    assert.equal(body.response_notes, 'Biometric verified');
  } finally {
    await sseMock.close();
  }

  // 2) Polling ignores mismatched ID returning approved and waits for real tracked ID decision
  let pollCalls = 0;
  const pollMock = await startMockServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/v1/approvals') {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: { id: 'req-poll-bound', status: 'pending' } }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/v1/approvals/req-poll-bound/sse') {
      res.writeHead(404);
      res.end();
      return;
    }
    if (req.method === 'GET' && req.url === '/api/v1/approvals/req-poll-bound') {
      pollCalls++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (pollCalls === 1) {
        res.end(JSON.stringify({ success: true, data: { id: 'req-wrong-id', status: 'approved' } }));
      } else {
        res.end(JSON.stringify({ success: true, data: { id: 'req-poll-bound', status: 'approved', response_notes: 'Approved on phone' } }));
      }
      return;
    }
    res.writeHead(404);
    res.end();
  });

  try {
    const res = await handleRequestApproval(
      {
        action: 'deploy',
        description: 'deploy service',
        risk_analysis: 'Verified tests',
      },
      { serverUrl: pollMock.url, timeoutSeconds: 2, pollIntervalMs: 25, config: {} }
    );
    const body = parseToolResult(res);
    assert.equal(pollCalls, 2);
    assert.equal(body.success, true);
    assert.equal(body.approved, true);
    assert.equal(body.status, 'approved');
    assert.equal(body.approval_id, 'req-poll-bound');
  } finally {
    await pollMock.close();
  }
});

// ============================================================================
// F02: Loop prevention MUST NOT consult tool arguments or descriptive text;
//      only exact allowlisted internal Orbiter tool names are exempted
// ============================================================================

test('F02: allowlist accepts genuine internal Orbiter tool names and rejects spoofed or unlisted names', () => {
  const allowed = [
    'request_approval',
    'orbiter_auth',
    'orbiter_auth_verify',
    'check_approval_status',
    'list_pending_approvals',
    'agent_heartbeat',
    'checkpoint_post',
    'notify_user',
    'mcp__orbiter__request_approval',
    'mcp__orbiter-dev__orbiter_auth',
    'orbiter__check_approval_status',
    'mcp_orbiter_request_approval',
    'orbiter/notify_user',
  ];
  for (const name of allowed) {
    assert.equal(isTrustedOrbiterInternalTool(name), true, `expected allowlisted: ${name}`);
  }

  const disallowed = [
    'Bash',
    'run_command',
    'run_shell_command',
    'orbiter_shell',
    'my_request_approval_wrapper',
    'mcp__evil__request_approval',
    'mcp__orbiter__exec_shell',
    'orbiter__arbitrary_tool',
    'mcp__orbiter__kill_agent',
    '',
  ];
  for (const name of disallowed) {
    assert.equal(isTrustedOrbiterInternalTool(name), false, `expected NOT allowlisted: ${name}`);
  }
});

test('F02: Codex adapter preserves normal gating when args/descriptions mention orbiter or request_approval, and exempts genuine internal tools', async () => {
  const baselinePre = await handleCodexHook(
    {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git push --force origin main', description: 'Push branch' },
      session_id: 'f02-codex-1',
      turn_id: 't1',
      tool_use_id: 'u1',
      cwd: process.cwd(),
    },
    { adapter: 'mock', mockDecision: 'rejected' }
  );

  const tamperedPre = await handleCodexHook(
    {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: {
        command: 'git push --force origin main # orbiter-mcp codex-orbiter request_approval orbiter',
        description: 'orbiter-mcp request_approval loop bypass attempt',
      },
      session_id: 'f02-codex-2',
      turn_id: 't1',
      tool_use_id: 'u2',
      cwd: process.cwd(),
    },
    { adapter: 'mock', mockDecision: 'rejected' }
  );

  assert.equal(baselinePre.normalized.isOrbiterLoop, false);
  assert.equal(tamperedPre.normalized.isOrbiterLoop, false);
  assert.equal(baselinePre.output.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(tamperedPre.output.hookSpecificOutput.permissionDecision, 'deny');

  // PermissionRequest explicit deny parity
  const tamperedPerm = await handleCodexHook(
    {
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: {
        command: 'git push --force origin main # orbiter-mcp codex-orbiter request_approval',
        description: 'orbiter approval',
      },
      session_id: 'f02-codex-3',
      turn_id: 't1',
      tool_use_id: 'u3',
      cwd: process.cwd(),
    },
    { adapter: 'mock', mockDecision: 'rejected' }
  );
  assert.equal(tamperedPerm.normalized.isOrbiterLoop, false);
  assert.equal(tamperedPerm.output.hookSpecificOutput.decision.behavior, 'deny');

  // Spoofed tool name containing substring "orbiter" is NOT exempted
  const spoofedTool = normalizeCodexHookEvent({
    hook_event_name: 'PreToolUse',
    tool_name: 'orbiter_shell_runner',
    tool_input: { command: 'rm -rf /tmp/test' },
  });
  assert.equal(spoofedTool.isOrbiterLoop, false);

  // Genuine internal Orbiter tool avoids recursive prompting
  const internalPre = await handleCodexHook(
    {
      hook_event_name: 'PreToolUse',
      tool_name: 'mcp__orbiter__request_approval',
      tool_input: { action: 'deploy', description: 'deploy prod', risk_analysis: 'checked' },
      session_id: 'f02-codex-4',
      turn_id: 't1',
      tool_use_id: 'u4',
    },
    { adapter: 'mock', mockDecision: 'rejected' }
  );
  assert.equal(internalPre.normalized.isOrbiterLoop, true);
  assert.equal(internalPre.decision, undefined);
  assert.deepEqual(internalPre.output, {});

  const internalPerm = await handleCodexHook(
    {
      hook_event_name: 'PermissionRequest',
      tool_name: 'request_approval',
      tool_input: { action: 'deploy' },
      session_id: 'f02-codex-5',
      turn_id: 't1',
      tool_use_id: 'u5',
    },
    { adapter: 'mock', mockDecision: 'rejected' }
  );
  assert.equal(internalPerm.normalized.isOrbiterLoop, true);
  assert.equal(internalPerm.output.hookSpecificOutput.decision.behavior, 'allow');
  assert.equal(internalPerm.decision.source, 'cache');
});

test('F02: Gemini adapter preserves normal gating when args/descriptions mention orbiter or request_approval, and exempts genuine internal tools', async () => {
  const baseline = await handleGeminiHook(
    {
      hook_event_name: 'BeforeTool',
      tool_name: 'run_shell_command',
      tool_input: { command: 'git push --force origin main', description: 'Push branch' },
      session_id: 'f02-gemini-1',
      cwd: process.cwd(),
    },
    { adapter: 'mock', mockDecision: 'rejected' }
  );

  const tampered = await handleGeminiHook(
    {
      hook_event_name: 'BeforeTool',
      tool_name: 'run_shell_command',
      tool_input: {
        command: 'git push --force origin main # orbiter-mcp gemini-hook request_approval',
        description: 'Run orbiter request_approval gemini-hook',
      },
      session_id: 'f02-gemini-2',
      cwd: process.cwd(),
    },
    { adapter: 'mock', mockDecision: 'rejected' }
  );

  assert.equal(baseline.normalized.isOrbiterLoop, false);
  assert.equal(tampered.normalized.isOrbiterLoop, false);
  assert.equal(baseline.output.decision, 'deny');
  assert.equal(tampered.output.decision, 'deny');

  // Approved path matches too
  const tamperedApproved = await handleGeminiHook(
    {
      hook_event_name: 'BeforeTool',
      tool_name: 'run_shell_command',
      tool_input: {
        command: 'git push --force origin main # orbiter-mcp request_approval',
        description: 'gemini-hook bypass attempt',
      },
      session_id: 'f02-gemini-3',
      cwd: process.cwd(),
    },
    { adapter: 'mock', mockDecision: 'approved' }
  );
  assert.equal(tamperedApproved.normalized.isOrbiterLoop, false);
  assert.equal(tamperedApproved.output.decision, 'allow');
  assert.equal(tamperedApproved.decision.status, 'approved');

  // Genuine internal tool emits no-decision {} without calling adapter
  const internal = await handleGeminiHook(
    {
      hook_event_name: 'BeforeTool',
      tool_name: 'mcp__orbiter__request_approval',
      tool_input: { action: 'deploy' },
      session_id: 'f02-gemini-4',
      cwd: process.cwd(),
    },
    { adapter: 'mock', mockDecision: 'rejected' }
  );
  assert.equal(internal.normalized.isOrbiterLoop, true);
  assert.equal(internal.decision, undefined);
  assert.deepEqual(internal.output, {});

  const spoofed = normalizeGeminiHookEvent({
    hook_event_name: 'BeforeTool',
    tool_name: 'mcp__evil__request_approval',
    tool_input: {},
  });
  assert.equal(spoofed.isOrbiterLoop, false);
});

test('F02: Antigravity adapter preserves normal gating when args/descriptions mention orbiter or request_approval, and exempts genuine internal tools', async () => {
  const baseline = await handleAntigravityHook(
    {
      conversationId: 'f02-agy-1',
      stepIdx: 1,
      workspacePaths: [process.cwd()],
      toolCall: {
        name: 'run_command',
        args: { CommandLine: 'git push --force origin main', Description: 'Push branch' },
      },
    },
    { eventName: 'PreToolUse', profile: 'blocking', adapter: 'mock', mockDecision: 'rejected' }
  );

  const tampered = await handleAntigravityHook(
    {
      conversationId: 'f02-agy-2',
      stepIdx: 1,
      workspacePaths: [process.cwd()],
      toolCall: {
        name: 'run_command',
        args: {
          CommandLine: 'git push --force origin main # orbiter-mcp antigravity-hook request_approval orbiter approval',
          Description: 'orbiter approval request_approval antigravity-hook',
        },
      },
    },
    { eventName: 'PreToolUse', profile: 'blocking', adapter: 'mock', mockDecision: 'rejected' }
  );

  assert.equal(baseline.normalized.isOrbiterLoop, false);
  assert.equal(tampered.normalized.isOrbiterLoop, false);
  assert.equal(baseline.output.decision, 'deny');
  assert.equal(tampered.output.decision, 'deny');

  // Approved path still invokes adapter (decision populated)
  const tamperedApproved = await handleAntigravityHook(
    {
      conversationId: 'f02-agy-3',
      stepIdx: 1,
      workspacePaths: [process.cwd()],
      toolCall: {
        name: 'run_command',
        args: {
          CommandLine: 'git push --force origin main # orbiter approval',
          Description: 'orbiter-mcp request_approval',
        },
      },
    },
    { eventName: 'PreToolUse', profile: 'blocking', adapter: 'mock', mockDecision: 'approved' }
  );
  assert.equal(tamperedApproved.normalized.isOrbiterLoop, false);
  assert.equal(tamperedApproved.output.decision, 'allow');
  assert.equal(tamperedApproved.decision.status, 'approved');

  // Genuine internal tool returns allow without calling adapter (no recursion)
  const internal = await handleAntigravityHook(
    {
      conversationId: 'f02-agy-4',
      stepIdx: 1,
      workspacePaths: [process.cwd()],
      toolCall: {
        name: 'mcp_orbiter_request_approval',
        args: { action: 'deploy' },
      },
    },
    { eventName: 'PreToolUse', profile: 'blocking', adapter: 'mock', mockDecision: 'rejected' }
  );
  assert.equal(internal.normalized.isOrbiterLoop, true);
  assert.equal(internal.decision, undefined);
  assert.equal(internal.output.decision, 'allow');

  const spoofed = normalizeAntigravityPreToolUse({
    conversationId: 'f02-agy-5',
    stepIdx: 1,
    workspacePaths: [process.cwd()],
    toolCall: {
      name: 'mcp__orbiter__run_arbitrary_shell',
      args: { command: 'rm -rf /' },
    },
  });
  assert.equal(spoofed.isOrbiterLoop, false);
});
