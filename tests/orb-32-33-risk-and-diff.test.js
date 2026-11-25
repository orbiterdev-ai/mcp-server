const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// ORB-32 & ORB-33 regression suite:
//   - ORB-32: Hook normalizers must not duplicate tool_input_json preview inside diff_summary.
//   - ORB-33: Read-only & agent-coordination tools across Antigravity, Claude Code, Codex,
//     and Cursor must classify as `low` (and bypass blocking approval on Antigravity),
//     while credential reads, destructive shell/DB commands, and external publishes stay
//     `high` or `critical`.

function pick(mod, name) {
  if (mod[name] !== undefined) return mod[name];
  if (mod.default && mod.default[name] !== undefined) return mod.default[name];
  return undefined;
}

async function loadAll() {
  const agHooks = await import('../dist/antigravity/hooks.js');
  const agRisk = await import('../dist/antigravity/risk.js');
  const codexHooks = await import('../dist/codex/hooks.js');
  const codexAppServer = await import('../dist/codex/appServer.js');
  const geminiHooks = await import('../dist/gemini/hooks.js');
  const toolRisk = await import('../dist/policy/toolRisk.js');
  const rulesetV2 = await import('../dist/policy/rulesetV2.js');
  const genericV2 = await import('../dist/policy/genericRulesetV2.js');
  return {
    normalizeAntigravityPreToolUse: pick(agHooks, 'normalizeAntigravityPreToolUse'),
    handleAntigravityHook: pick(agHooks, 'handleAntigravityHook'),
    evaluateAntigravityRiskWithPolicy: pick(agRisk, 'evaluateAntigravityRiskWithPolicy'),
    evaluateAntigravityRisk: pick(agRisk, 'evaluateAntigravityRisk'),
    normalizeCodexHookEvent: pick(codexHooks, 'normalizeCodexHookEvent'),
    normalizeCodexAppServerApprovalRequest: pick(codexAppServer, 'normalizeCodexAppServerApprovalRequest'),
    normalizeGeminiHookEvent: pick(geminiHooks, 'normalizeGeminiHookEvent'),
    computeToolRisk: pick(toolRisk, 'computeToolRisk'),
    evaluateRulesetV2: pick(rulesetV2, 'evaluateRulesetV2'),
    genericRulesetV2For: pick(genericV2, 'genericRulesetV2For'),
  };
}

test('ORB-33: Antigravity read-only and coordination tools classify as low and do not require blocking approval', async () => {
  const { normalizeAntigravityPreToolUse, handleAntigravityHook } = await loadAll();
  delete process.env.ORBITER_HOOK_POLICY;
  delete process.env.ORBITER_MIN_RISK;

  const workspacePaths = ['/workspace/demo-app', '/workspace/demo-app-android', '/workspace/demo-app-v4'];
  const artifactDir = '/home/developer/.gemini/antigravity/brain/00000000-0000-0000-0000-000000000000';

  const safePayloads = [
    { name: 'view_file', args: { AbsolutePath: '/workspace/demo-app/docs/shipping/release_manifest.json' } },
    { name: 'view_file', args: { AbsolutePath: `${artifactDir}/.system_generated/steps/4/content.md` } },
    { name: 'read_file', args: { Path: '/workspace/demo-app/mcp/package.json' } },
    { name: 'list_dir', args: { DirectoryPath: `${artifactDir}/scratch` } },
    { name: 'find_by_name', args: { SearchDirectory: '/workspace/demo-app/backend', Pattern: '*migration*.sql' } },
    { name: 'grep_search', args: { SearchPath: '/workspace/demo-app/backend', Query: 'DROP TABLE users' } },
    { name: 'grep_search', args: { SearchPath: '/workspace/demo-app/mcp', Query: 'rm -rf /' } },
    { name: 'manage_subagents', args: { Action: 'list' } },
    { name: 'send_message', args: { Recipient: '11111111-1111-1111-1111-111111111111', Message: 'Verified git push and .env guards are intact.' } },
    { name: 'manage_task', args: { Action: 'list' } },
    { name: 'manage_task', args: { Action: 'status', TaskId: 'task-117' } },
    { name: 'update_focus', args: { focus: 'Auditing DROP TABLE migration script' } },
    { name: 'update_steps', args: { steps: [{ title: 'Run backend tests', status: 'in_progress' }] } },
    { name: 'view_file_outline', args: { AbsolutePath: '/workspace/demo-app/backend/internal/api/handlers/approvals.go' } },
    { name: 'view_code_item', args: { File: '/workspace/demo-app/backend/internal/api/handlers/approvals.go', NodePaths: ['CreateApproval'] } },
  ];

  for (const toolCall of safePayloads) {
    const payload = {
      conversationId: '00000000-0000-0000-0000-000000000000',
      stepIdx: 12,
      workspacePaths,
      artifactDirectoryPath: artifactDir,
      toolCall,
    };
    const normalized = normalizeAntigravityPreToolUse(payload, 'blocking');
    assert.equal(
      normalized.risk.level,
      'low',
      `expected low for Antigravity ${toolCall.name} (${JSON.stringify(toolCall.args)}), got ${normalized.risk.level}: ${normalized.risk.reasons.join('; ')}`,
    );
    assert.equal(normalized.requiresApproval, false, `expected requiresApproval=false for ${toolCall.name}`);

    const handled = await handleAntigravityHook(payload, {
      eventName: 'PreToolUse',
      profile: 'blocking',
      adapter: 'mock',
      mockDecision: 'rejected',
    });
    assert.equal(handled.output.decision, 'allow', `safe tool ${toolCall.name} must allow locally without mobile prompt`);
    assert.equal(handled.decision, undefined, `safe tool ${toolCall.name} must not call approval adapter`);
  }
});

test('ORB-33: Destructive shell, credential reads, DB mutations, and publishes remain high/critical on Antigravity', async () => {
  const { evaluateAntigravityRiskWithPolicy, evaluateAntigravityRisk } = await loadAll();
  delete process.env.ORBITER_HOOK_POLICY;

  const ws = ['/workspace/demo-app'];
  const highOrCriticalCases = [
    ['run_command', { CommandLine: 'rm -rf /', Cwd: '/workspace/demo-app' }, 'critical'],
    ['run_command', { CommandLine: 'git reset --hard HEAD~1', Cwd: '/workspace/demo-app' }, 'critical'],
    ['run_command', { CommandLine: 'npm publish --access public', Cwd: '/workspace/demo-app/mcp' }, 'high'],
    ['run_command', { CommandLine: 'git push origin main', Cwd: '/workspace/demo-app' }, 'high'],
    ['run_command', { CommandLine: 'psql -c "DROP TABLE public.approvals;"', Cwd: '/workspace/demo-app' }, 'high'],
    ['run_command', { CommandLine: 'supabase db reset', Cwd: '/workspace/demo-app' }, 'high'],
    ['view_file', { AbsolutePath: '/workspace/demo-app/backend/.env' }, 'critical'],
    ['read_file', { Path: '/home/developer/.ssh/id_rsa' }, 'critical'],
    ['write_to_file', { TargetFile: '/workspace/demo-app/docs/shipping/release_manifest.json' }, 'critical'],
    ['write_to_file', { TargetFile: '/workspace/demo-app/backend/.env.production' }, 'critical'],
    ['manage_task', { Action: 'kill', TaskId: 'task-99' }, 'high'],
    ['mcp_supabase_apply_migration', { serverName: 'supabase' }, 'high'],
    ['browser_click', { Url: 'https://dash.cloudflare.com' }, 'high'],
  ];

  for (const [tool, args, expected] of highOrCriticalCases) {
    const v2 = evaluateAntigravityRiskWithPolicy(tool, args, ws);
    const legacy = evaluateAntigravityRisk(tool, args, ws);
    assert.equal(v2.level, expected, `v2 ${tool} ${JSON.stringify(args)} -> ${v2.level} (want ${expected})`);
    assert.equal(legacy.level, expected, `legacy ${tool} ${JSON.stringify(args)} -> ${legacy.level} (want ${expected})`);
  }
});

test('ORB-33: Claude Code, Codex, and Cursor read-only tools classify low while destructive/secret calls stay high/critical', async () => {
  const { computeToolRisk, normalizeCodexHookEvent, evaluateRulesetV2, genericRulesetV2For } = await loadAll();
  delete process.env.ORBITER_HOOK_POLICY;

  // Claude Code read-only tools
  assert.equal(computeToolRisk('Read', JSON.stringify({ file_path: '/repo/backend/go.mod' })), 'low');
  assert.equal(computeToolRisk('Grep', JSON.stringify({ pattern: 'DROP TABLE users', path: '/repo/backend' })), 'low');
  assert.equal(computeToolRisk('Grep', JSON.stringify({ pattern: 'rm -rf /', path: '/repo/scripts' })), 'low');
  assert.equal(computeToolRisk('Glob', JSON.stringify({ pattern: '**/migrations/*.sql' })), 'low');
  assert.equal(computeToolRisk('LS', JSON.stringify({ path: '/repo/backend' })), 'low');
  // Claude Code credential read & destructive shell stay high/critical
  assert.equal(computeToolRisk('Read', JSON.stringify({ file_path: '/repo/backend/.env' })), 'high');
  assert.equal(computeToolRisk('Bash', JSON.stringify({ command: 'rm -rf /' })), 'critical');
  assert.equal(computeToolRisk('Bash', JSON.stringify({ command: 'psql -c "DROP TABLE audit_events"' })), 'high');
  assert.equal(computeToolRisk('Bash', JSON.stringify({ command: 'npm publish' })), 'high');

  // Codex read-only tools
  const codexRead = normalizeCodexHookEvent({
    hook_event_name: 'PreToolUse',
    tool_name: 'read_file',
    tool_input: { path: '/workspace/demo-app/backend/go.mod' },
    session_id: 'sess-codex-1',
    turn_id: 'turn-1',
    tool_use_id: 'use-1',
    cwd: '/workspace/demo-app',
  });
  assert.equal(codexRead.risk, 'low');

  const codexGrep = normalizeCodexHookEvent({
    hook_event_name: 'PreToolUse',
    tool_name: 'grep_files',
    tool_input: { pattern: 'git push origin main', path: '/workspace/demo-app' },
    session_id: 'sess-codex-1',
    turn_id: 'turn-2',
    tool_use_id: 'use-2',
    cwd: '/workspace/demo-app',
  });
  assert.equal(codexGrep.risk, 'low');

  const codexEnvRead = normalizeCodexHookEvent({
    hook_event_name: 'PreToolUse',
    tool_name: 'read_file',
    tool_input: { path: '/workspace/demo-app/backend/.env' },
    session_id: 'sess-codex-1',
    turn_id: 'turn-3',
    tool_use_id: 'use-3',
    cwd: '/workspace/demo-app',
  });
  assert.equal(codexEnvRead.risk, 'high');

  // Cursor read-only & search tool names (evaluated via converged generic v2 ruleset)
  for (const [toolName, args] of [
    ['read_file', { target_file: '/repo/package.json' }],
    ['list_dir', { relative_workspace_path: '/repo/migrations' }],
    ['file_search', { query: 'secret_register.json' }],
    ['grep_search', { query: 'TRUNCATE TABLE' }],
    ['codebase_search', { query: 'how does sudo check work' }],
    ['read_lints', { paths: ['/repo/backend/go.mod'] }],
  ]) {
    const res = evaluateRulesetV2(genericRulesetV2For('claude'), { toolName, args });
    assert.equal(res.level, 'low', `Cursor tool ${toolName} should classify low, got ${res.level}`);
  }
  const cursorSecretRead = evaluateRulesetV2(genericRulesetV2For('claude'), {
    toolName: 'read_file',
    args: { target_file: '/repo/backend/.env' },
  });
  assert.equal(cursorSecretRead.level, 'high');
});

test('ORB-32: Antigravity, Codex, Gemini, and App Server hook normalizers do not duplicate tool_input_json into diff_summary', async () => {
  const {
    normalizeAntigravityPreToolUse,
    normalizeCodexHookEvent,
    normalizeCodexAppServerApprovalRequest,
    normalizeGeminiHookEvent,
  } = await loadAll();

  const agFixture = require(path.join('..', 'fixtures', 'antigravity', 'pretool-run-command.json'));
  const agNorm = normalizeAntigravityPreToolUse(agFixture);
  assert.equal(agNorm.approval.diff_summary, '', 'Antigravity hook must not mirror tool_input_json preview in diff_summary');
  assert.match(agNorm.approval.tool_input_json, /redacted_preview/);

  const codexNorm = normalizeCodexHookEvent({
    session_id: 'sess-orb32',
    turn_id: 'turn-1',
    tool_use_id: 'use-1',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    cwd: '/workspace/demo-app',
    model: 'gpt-5.4',
    tool_input: { command: 'git push origin main' },
  });
  assert.equal(codexNorm.approval.diff_summary, '', 'Codex hook must not mirror tool_input_json preview in diff_summary');
  assert.match(codexNorm.approval.tool_input_json, /git push origin main/);

  const geminiNorm = normalizeGeminiHookEvent({
    hook_event_name: 'BeforeTool',
    tool_name: 'run_shell_command',
    tool_input: { command: 'npm publish' },
    session_id: 'sess-gem-orb32',
    cwd: '/workspace/demo-app',
  });
  assert.equal(geminiNorm.approval.diff_summary, '', 'Gemini hook must not mirror tool_input_json preview in diff_summary');
  assert.match(geminiNorm.approval.tool_input_json, /npm publish/);

  const appCmdFixture = require(path.join('..', 'fixtures', 'codex', 'appserver-command-approval.json'));
  const appCmdNorm = normalizeCodexAppServerApprovalRequest(appCmdFixture);
  assert.equal(appCmdNorm.approval.diff_summary, '', 'App Server command approval must not mirror tool_input_json preview');

  const appFileFixture = require(path.join('..', 'fixtures', 'codex', 'appserver-file-approval.json'));
  const appFileNorm = normalizeCodexAppServerApprovalRequest(appFileFixture);
  assert.ok(!appFileNorm.approval.diff_summary.includes('"input_preview"'), 'App Server file approval must store concise file list, not JSON preview mirror');
});
