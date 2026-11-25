const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process['env'].ORBITER_CODEX_IDEMPOTENCY_STORE = path.join(require('node:os').tmpdir(), 'orbiter-dev-codex-idempotency-test.json');

const {
  handleCodexHook,
  normalizeCodexHookEvent,
} = require('../dist/codex/hooks.js');
const {
  mapCodexAppServerDecision,
  normalizeCodexAppServerApprovalRequest,
  requestCodexAppServerApproval,
} = require('../dist/codex/appServer.js');
const {
  analyzeCodexConfig,
  codexConfigHookEventsForProfile,
  patchCodexConfig,
  unpatchCodexConfig,
} = require('../dist/codex/config.js');
const { evaluateCodexRisk } = require('../dist/codex/risk.js');
const {
  handleAntigravityHook,
  mapDecisionToPreToolUseOutput,
  normalizeAntigravityPreToolUse,
} = require('../dist/antigravity/hooks.js');
const {
  antigravityRiskRequiresApproval,
  evaluateAntigravityRisk,
} = require('../dist/antigravity/risk.js');
const {
  analyzeAntigravityHooksConfig,
  patchAntigravityHooksConfig,
  unpatchAntigravityHooksConfig,
} = require('../dist/antigravity/config.js');

test('normalizes Codex PermissionRequest into Orbiter approval payload', () => {
  const normalized = normalizeCodexHookEvent({
    session_id: 's1',
    turn_id: 't1',
    tool_use_id: 'u1',
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    cwd: '/workspace/demo-app',
    model: 'gpt-5.5',
    tool_input: {
      command: 'git status --short',
      env: { ORBITER_TOKEN: 'secret-token' },
    },
  });

  assert.equal(normalized.approval.source_ide, 'codex');
  assert.equal(normalized.approval.tool_name, 'Bash');
  assert.equal(normalized.approval.risk_level, 'low');
  assert.equal(normalized.approval.auto_approve, true);
  assert.ok(normalized.metadata.codex_tool_input_hash.length >= 32);
  assert.match(normalized.metadata.codex_tool_input_preview, /\[redacted\]/);
  assert.match(normalized.approval.tool_input_json, /redacted_preview/);
  assert.doesNotMatch(normalized.approval.tool_input_json, /zero_data_mode/);
  assert.doesNotMatch(normalized.approval.diff_summary, /zero_data_mode/);
});

test('PermissionRequest approval returns Codex allow JSON', async () => {
  const result = await handleCodexHook({
    session_id: 's1',
    turn_id: 't1',
    tool_use_id: 'u1',
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'git status --short' },
  }, { adapter: 'mock', mockDecision: 'approved' });

  assert.deepEqual(result.output, {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow' },
    },
  });
});

test('Codex internal plan PermissionRequest bypasses mobile approval', async () => {
  const result = await handleCodexHook({
    session_id: 'plan-s1',
    turn_id: 'plan-t1',
    tool_use_id: 'plan-u1',
    hook_event_name: 'PermissionRequest',
    tool_name: 'Plan',
    tool_input: {
      title: 'Implement this plan?',
      plan: 'Update documentation and run validation.',
    },
  }, { adapter: 'mock', mockDecision: 'rejected' });

  assert.deepEqual(result.output, {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow' },
    },
  });
  assert.equal(result.decision.status, 'approved');
  assert.match(result.decision.notes, /internal plan/);
});

test('low-risk real tool PermissionRequest mentioning plan auto-allows without internal-plan bypass', async () => {
  const result = await handleCodexHook({
    session_id: 'plan-real-s1',
    turn_id: 'plan-real-t1',
    tool_use_id: 'plan-real-u1',
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: {
      command: 'echo "implement this plan"',
    },
  }, { adapter: 'mock', mockDecision: 'rejected' });

  assert.match(JSON.stringify(result.output), /allow/);
  assert.equal(result.normalized.approval.auto_approve, true);
  assert.equal(result.decision.status, 'approved');
  assert.doesNotMatch(result.decision.notes, /internal plan/);
});

test('medium and high Codex PermissionRequests are not client-auto-approved', () => {
  const medium = normalizeCodexHookEvent({
    session_id: 'medium-s1',
    turn_id: 'medium-t1',
    tool_use_id: 'medium-u1',
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: {
      command: 'node -e "console.log(require(\'./package.json\').name)"',
    },
  });
  const high = normalizeCodexHookEvent({
    session_id: 'high-s1',
    turn_id: 'high-t1',
    tool_use_id: 'high-u1',
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: {
      command: 'npm publish',
    },
  });

  assert.equal(medium.approval.risk_level, 'medium');
  assert.equal(medium.approval.auto_approve, false);
  assert.equal(high.approval.risk_level, 'high');
  assert.equal(high.approval.auto_approve, false);
});

test('risky PreToolUse denial returns Codex deny JSON', async () => {
  const result = await handleCodexHook({
    session_id: 's2',
    turn_id: 't2',
    tool_use_id: 'u2',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'npm publish' },
  }, { adapter: 'mock', mockDecision: 'rejected' });

  assert.equal(result.output.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(result.output.hookSpecificOutput.permissionDecision, 'deny');
});

test('critical PreToolUse routes to approval by default (2026-07-01: the phone stays the only approver)', async () => {
  const result = await handleCodexHook({
    session_id: 's3',
    turn_id: 't3',
    tool_use_id: 'u3',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf /' },
  }, { adapter: 'mock', mockDecision: 'approved' });

  assert.equal(result.normalized.risk, 'critical');
  assert.ok(result.decision, 'critical must request a mobile decision by default');
  assert.deepEqual(result.output, {});
});

test('critical PreToolUse blocks locally when criticalMode=deny (pre-2026-07 behavior)', async () => {
  const result = await handleCodexHook({
    session_id: 's3b',
    turn_id: 't3b',
    tool_use_id: 'u3b',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf /' },
  }, { adapter: 'mock', mockDecision: 'approved', criticalMode: 'deny' });

  assert.equal(result.normalized.risk, 'critical');
  assert.equal(result.decision, undefined);
  assert.match(JSON.stringify(result.output), /critical risk/);
});

test('App Server command approval maps approved decisions to acceptForSession when requested', async () => {
  const fixture = require(path.join('..', 'fixtures', 'codex', 'appserver-command-approval.json'));
  const result = await requestCodexAppServerApproval(fixture, {
    adapter: 'mock',
    mockDecision: 'approved',
    acceptScope: 'session',
  });

  assert.equal(result.appServerDecision, 'acceptForSession');
  assert.equal(result.normalized.approval.risk_level, 'high');
  assert.match(result.normalized.approval.action, /npm publish/);
});

test('App Server file approval preserves file count and redacted-preview payload shape', () => {
  const fixture = require(path.join('..', 'fixtures', 'codex', 'appserver-file-approval.json'));
  const normalized = normalizeCodexAppServerApprovalRequest(fixture);

  assert.equal(normalized.approval.file_count, 2);
  assert.match(normalized.approval.action, /2 files/);
  assert.match(normalized.approval.tool_input_json, /redacted_preview/);
  assert.doesNotMatch(normalized.approval.tool_input_json, /zero_data_mode/);
  assert.doesNotMatch(normalized.approval.diff_summary, /zero_data_mode/);
});

test('App Server rejected and timeout decisions map to decline and cancel', () => {
  assert.equal(mapCodexAppServerDecision({ status: 'rejected' }), 'decline');
  assert.equal(mapCodexAppServerDecision({ status: 'timeout', timedOut: true }), 'cancel');
  assert.equal(mapCodexAppServerDecision({ status: 'pending' }), 'cancel');
});

test('risk evaluator classifies critical destructive root commands', () => {
  assert.equal(evaluateCodexRisk('Codex Bash: rm -rf /', 'rm -rf /'), 'critical');
});

test('invalid PermissionRequest payload fails closed', async () => {
  const result = await handleCodexHook({
    hook_event_name: 'PermissionRequest',
  }, { adapter: 'mock', mockDecision: 'approved' });

  assert.match(JSON.stringify(result.output), /deny/);
});

test('config setup installs minimal hook profile and can uninstall cleanly', () => {
  const cliPath = '/workspace/demo-app/mcp/dist/index.js';
  const patched = patchCodexConfig('', { cliPath }, {
    adapter: 'mock',
    mockDecision: 'approved',
    approvalTimeoutSeconds: 120,
    hookProfile: 'minimal',
  });
  const analysis = analyzeCodexConfig(patched, cliPath);

  assert.match(patched, /hooks = true # orbiter-dev-codex/);
  assert.match(patched, /codex-hook --adapter mock --timeout 120 --mock-decision approved/);
  assert.match(patched, /ORBITER_CREDENTIAL_PROFILE = "codex"/);
  assert.match(patched, /ORBITER_IDE_NAME = "Codex"/);
  assert.equal(analysis.ownedBlockCount, 1);
  assert.equal(analysis.bridgeHookCounts.PermissionRequest, 1);
  assert.equal(analysis.bridgeHookCounts.PreToolUse, 0);
  assert.equal(analysis.hasDuplicateBridgeHooks, false);
  assert.equal(analysis.hasOrbiterMcpServer, true);
  assert.equal(unpatchCodexConfig(patched), '');
});

test('config setup full profile covers all supported hook events without duplicates', () => {
  const cliPath = '/workspace/demo-app/mcp/dist/index.js';
  const patched = patchCodexConfig('[features]\nhooks = false\n', { cliPath }, {
    adapter: 'http',
    serverUrl: 'https://api.orbiterdev.ai',
    hookProfile: 'full',
  });
  const analysis = analyzeCodexConfig(patched, cliPath);

  assert.equal(analysis.hooksFeatureEnabled, true);
  assert.equal(analysis.hooksFeatureDisabled, false);
  for (const event of codexConfigHookEventsForProfile('full')) {
    assert.equal(analysis.bridgeHookCounts[event], 1);
  }
  assert.equal(analysis.hasDuplicateBridgeHooks, false);
  assert.match(patched, /--server-url "https:\/\/api\.orbiterdev\.ai"/);
});

test('normalizes Antigravity PreToolUse into deterministic Orbiter approval payload', () => {
  const fixture = require(path.join('..', 'fixtures', 'antigravity', 'pretool-run-command.json'));
  const normalized = normalizeAntigravityPreToolUse(fixture);

  assert.equal(normalized.approval.source_ide, 'antigravity');
  assert.equal(normalized.approval.tool_name, 'run_command');
  assert.equal(normalized.requiresApproval, true);
  assert.ok(normalized.metadata.antigravity_idempotency_key.startsWith('antigravity:'));
  assert.match(normalized.approval.tool_input_json, /redacted_preview/);
  assert.doesNotMatch(normalized.approval.tool_input_json, /zero_data_mode/);
  assert.doesNotMatch(normalized.approval.diff_summary, /zero_data_mode/);
});

test('Antigravity approved PreToolUse blocks until decision then returns allow JSON', async () => {
  const fixture = require(path.join('..', 'fixtures', 'antigravity', 'pretool-run-command.json'));
  const result = await handleAntigravityHook(fixture, {
    eventName: 'PreToolUse',
    adapter: 'mock',
    mockDecision: 'approved',
    profile: 'blocking',
    fallback: 'deny',
  });

  assert.deepEqual(result.output, {
    decision: 'allow',
    reason: 'Mock adapter returned approved',
    permissionOverrides: ['command(npm test)'],
  });
});

test('Antigravity blocking profile routes network, browser, and MCP surfaces through approval', () => {
  const workspacePaths = ['/workspace/demo-app'];
  const network = evaluateAntigravityRisk('read_url_content', { Url: 'https://antigravity.google/docs/hooks' }, workspacePaths);
  const browser = evaluateAntigravityRisk('browser_click', { Url: 'https://example.com/settings' }, workspacePaths);
  const mcp = evaluateAntigravityRisk('mcp_supabase_apply_migration', { serverName: 'supabase' }, workspacePaths);

  assert.equal(network.level, 'medium');
  assert.equal(antigravityRiskRequiresApproval('read_url_content', network, 'blocking'), true);
  assert.equal(browser.level, 'high');
  assert.equal(antigravityRiskRequiresApproval('browser_click', browser, 'blocking'), true);
  assert.equal(mcp.level, 'high');
  assert.equal(antigravityRiskRequiresApproval('mcp_supabase_apply_migration', mcp, 'blocking'), true);
});

test('Antigravity strict PreInvocation injects approval guardrail', async () => {
  const result = await handleAntigravityHook({
    invocationNum: 2,
    initialNumSteps: 4,
    conversationId: '00000000-0000-0000-0000-000000000000',
    workspacePaths: ['/workspace/demo-app'],
  }, {
    eventName: 'PreInvocation',
    profile: 'strict',
  });

  assert.equal(result.output.injectSteps.length, 1);
  assert.match(result.output.injectSteps[0].ephemeralMessage, /Orbiter approval gate is active/);
});

test('Antigravity rejected PreToolUse returns deny JSON', async () => {
  const fixture = require(path.join('..', 'fixtures', 'antigravity', 'pretool-run-command.json'));
  const result = await handleAntigravityHook(fixture, {
    eventName: 'PreToolUse',
    adapter: 'mock',
    mockDecision: 'rejected',
    profile: 'blocking',
    fallback: 'deny',
  });

  assert.deepEqual(result.output, {
    decision: 'deny',
    reason: 'Mock adapter returned rejected',
  });
});

test('Antigravity timeout fails closed by default for deterministic blocking', async () => {
  const fixture = require(path.join('..', 'fixtures', 'antigravity', 'pretool-run-command.json'));
  const result = await handleAntigravityHook(fixture, {
    eventName: 'PreToolUse',
    adapter: 'mock',
    mockDecision: 'timeout',
    profile: 'blocking',
    fallback: 'deny',
  });

  assert.equal(result.output.decision, 'deny');
  assert.match(result.output.reason, /timeout/);
});

test('Antigravity timeout can explicitly fall back to local force_ask', () => {
  const output = mapDecisionToPreToolUseOutput({
    status: 'timeout',
    notes: 'No mobile decision in time',
    timedOut: true,
    source: 'mock',
  }, 'force_ask');

  assert.deepEqual(output, {
    decision: 'force_ask',
    reason: 'No mobile decision in time',
  });
});

test('Antigravity critical sensitive file write routes to approval by default', async () => {
  const fixture = require(path.join('..', 'fixtures', 'antigravity', 'pretool-write-file.json'));
  const result = await handleAntigravityHook(fixture, {
    eventName: 'PreToolUse',
    adapter: 'mock',
    mockDecision: 'approved',
    profile: 'blocking',
  });

  assert.ok(result.decision, 'critical must request a mobile decision by default');
  assert.equal(result.output.decision, 'allow');
});

test('Antigravity critical sensitive file write blocks locally when criticalMode=deny', async () => {
  const fixture = require(path.join('..', 'fixtures', 'antigravity', 'pretool-write-file.json'));
  const result = await handleAntigravityHook(fixture, {
    eventName: 'PreToolUse',
    adapter: 'mock',
    mockDecision: 'approved',
    profile: 'blocking',
    criticalMode: 'deny',
  });

  assert.equal(result.output.decision, 'deny');
  assert.match(result.output.reason, /sensitive/i);
  assert.equal(result.decision, undefined);
});

test('Antigravity malformed PreToolUse fails closed', async () => {
  const fixture = require(path.join('..', 'fixtures', 'antigravity', 'malformed-missing-toolcall.json'));
  const result = await handleAntigravityHook(fixture, {
    eventName: 'PreToolUse',
    adapter: 'mock',
    mockDecision: 'approved',
  });

  assert.equal(result.output.decision, 'deny');
  assert.match(result.output.reason, /Invalid Antigravity PreToolUse payload/);
});

test('Antigravity hooks config setup installs blocking all-tool matcher and uninstalls cleanly', () => {
  const cliPath = '/workspace/demo-app/mcp/dist/index.js';
  const patched = patchAntigravityHooksConfig('', { cliPath }, {
    adapter: 'mock',
    mockDecision: 'approved',
    approvalTimeoutSeconds: 300,
    profile: 'blocking',
    fallback: 'deny',
  });
  const analysis = analyzeAntigravityHooksConfig(patched, cliPath);

  assert.equal(analysis.ownedHookPresent, true);
  assert.equal(analysis.ownedHookEnabled, true);
  assert.equal(analysis.preToolUseHookCount, 1);
  assert.equal(analysis.postToolUseHookCount, 1);
  assert.equal(analysis.preInvocationHookCount, 1);
  assert.equal(analysis.postInvocationHookCount, 1);
  assert.equal(analysis.stopHookCount, 1);
  assert.equal(analysis.matcher, '*');
  assert.equal(analysis.timeoutSeconds, 300);
  assert.match(patched, /antigravity-hook PreToolUse/);
  assert.match(patched, /antigravity-hook PreInvocation/);
  assert.match(patched, /antigravity-hook PostInvocation/);
  assert.match(patched, /--fallback deny/);
  assert.equal(unpatchAntigravityHooksConfig(patched), '');
});
