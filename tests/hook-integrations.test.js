const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const packageRoot = path.resolve(__dirname, '..');
const cliPath = path.join(packageRoot, 'dist', 'index.js');
const bridgeRoot = path.join(packageRoot, 'orbiter-bridge');
const bridgeDist = path.join(bridgeRoot, 'dist');

function runNode(args, options = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: options.cwd || packageRoot,
    env: {
      ...process.env,
      ORBITER_CODEX_IDEMPOTENCY_STORE: path.join(os.tmpdir(), 'orbiter-hook-suite-idempotency.json'),
      ...options.env,
    },
    input: options.input,
    encoding: 'utf8',
    timeout: options.timeout || 15000,
  });
  if (result.error) throw result.error;
  return result;
}

function runCli(args, options = {}) {
  return runNode([cliPath, ...args], options);
}

function parseJsonStdout(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.trim().length > 0, 'expected stdout JSON');
  return JSON.parse(result.stdout);
}

function parseOnlyJsonLine(result) {
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, `expected exactly one JSON line, got ${lines.length}: ${result.stdout}`);
  return JSON.parse(lines[0]);
}

function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readFixture(relativePath) {
  return fs.readFileSync(path.join(packageRoot, 'fixtures', relativePath), 'utf8');
}

function listJsonFiles(root, prefix = '') {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const relativePath = path.join(prefix, entry.name);
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJsonFiles(fullPath, relativePath));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(relativePath);
    }
  }
  return files;
}

test('Codex hook CLI emits PermissionRequest allow JSON from fixture', () => {
  const output = parseOnlyJsonLine(runCli([
    'codex-hook',
    '--fixture',
    'fixtures/codex/permission-request.json',
    '--adapter',
    'mock',
    '--mock-decision',
    'approved',
  ]));

  assert.deepEqual(output, {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow' },
    },
  });
});

test('Codex hook CLI denies rejected risky PreToolUse fixture', () => {
  const output = parseOnlyJsonLine(runCli([
    'codex-hook',
    '--fixture',
    'fixtures/codex/pretool-risky.json',
    '--adapter',
    'mock',
    '--mock-decision',
    'rejected',
  ]));

  assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /rejected/i);
});

test('Codex app-server fixture maps mobile approval to JSON-RPC accept response', () => {
  const output = parseJsonStdout(runCli([
    'codex-app-server',
    '--fixture',
    'fixtures/codex/appserver-command-approval.json',
    '--adapter',
    'mock',
    '--mock-decision',
    'approved',
  ]));

  assert.equal(output.success, true);
  assert.equal(output.decision, 'accept');
  assert.deepEqual(output.response, { id: 7, result: 'accept' });
  assert.equal(output.approval.status, 'approved');
  assert.equal(output.normalized.risk, 'high');
});

test('Codex setup, doctor, and uninstall are idempotent in an isolated home', () => {
  const codexHome = mkTempDir('orbiter-codex-hooks-');

  const setup = parseJsonStdout(runCli([
    'codex',
    'setup',
    '--codex-home',
    codexHome,
    '--adapter',
    'mock',
    '--mock-decision',
    'approved',
    '--hook-profile',
    'full',
  ]));
  assert.equal(setup.success, true);
  assert.equal(setup.analysis.ownedBlockCount, 1);
  assert.equal(setup.analysis.bridgeHookCounts.PermissionRequest, 1);
  assert.equal(setup.analysis.bridgeHookCounts.PreToolUse, 1);
  assert.equal(setup.analysis.bridgeHookCounts.PostToolUse, 1);
  assert.equal(setup.analysis.bridgeHookCounts.PreCompact, 1);
  assert.equal(setup.analysis.bridgeHookCounts.PostCompact, 1);
  assert.equal(setup.analysis.bridgeHookCounts.SubagentStart, 1);
  assert.equal(setup.analysis.bridgeHookCounts.SubagentStop, 1);

  const secondSetup = parseJsonStdout(runCli([
    'codex',
    'setup',
    '--codex-home',
    codexHome,
    '--adapter',
    'mock',
    '--mock-decision',
    'approved',
    '--hook-profile',
    'full',
  ]));
  assert.equal(secondSetup.analysis.hasDuplicateBridgeHooks, false);

  const doctor = parseJsonStdout(runCli([
    'codex',
    'doctor',
    '--codex-home',
    codexHome,
    '--adapter',
    'mock',
    '--mock-decision',
    'approved',
  ]));
  assert.equal(doctor.success, true);
  assert.deepEqual(doctor.checks.map((check) => [check.name, check.ok]), doctor.checks.map((check) => [check.name, true]));

  const uninstall = parseJsonStdout(runCli([
    'codex',
    'uninstall',
    '--codex-home',
    codexHome,
  ]));
  assert.equal(uninstall.success, true);
  assert.equal(uninstall.analysis.ownedBlockCount, 0);
  assert.equal(uninstall.analysis.hasDuplicateBridgeHooks, false);
});

test('Antigravity hook CLI covers allow, deny, timeout fallback, malformed input, and post-tool no-op', () => {
  const approved = parseOnlyJsonLine(runCli([
    'antigravity-hook',
    'PreToolUse',
    '--fixture',
    'fixtures/antigravity/pretool-run-command.json',
    '--adapter',
    'mock',
    '--mock-decision',
    'approved',
  ]));
  assert.equal(approved.decision, 'allow');
  assert.deepEqual(approved.permissionOverrides, ['command(npm test)']);

  const approvedNodeInline = parseOnlyJsonLine(runCli([
    'antigravity-hook',
    'PreToolUse',
    '--adapter',
    'mock',
    '--mock-decision',
    'approved',
  ], {
    input: JSON.stringify({
      toolCall: {
        name: 'run_command',
        args: {
          CommandLine: 'node -e "console.log(\'orbiter-agy-real-env-backend-only-20260525-003\')"',
          Cwd: '/workspace/demo-app-review',
          WaitMsBeforeAsync: 2000,
        },
      },
      stepIdx: 20,
      conversationId: '00000000-0000-0000-0000-000000000000',
      workspacePaths: ['/workspace/demo-app-review'],
    }),
  }));
  assert.equal(approvedNodeInline.decision, 'allow');
  assert.deepEqual(approvedNodeInline.permissionOverrides, ['command(node -e)']);

  const approvedMcpTool = parseOnlyJsonLine(runCli([
    'antigravity-hook',
    'PreToolUse',
    '--adapter',
    'mock',
    '--mock-decision',
    'approved',
  ], {
    input: JSON.stringify({
      toolCall: {
        name: 'mcp',
        args: {
          server: 'sql',
          tool: 'execute_mutation',
        },
      },
      stepIdx: 21,
      conversationId: '00000000-0000-0000-0000-000000000000',
      workspacePaths: ['/workspace/demo-app'],
    }),
  }));
  assert.equal(approvedMcpTool.decision, 'allow');
  assert.deepEqual(approvedMcpTool.permissionOverrides, ['mcp(sql/execute_mutation)']);

  const rejected = parseOnlyJsonLine(runCli([
    'antigravity-hook',
    'PreToolUse',
    '--fixture',
    'fixtures/antigravity/pretool-run-command.json',
    '--adapter',
    'mock',
    '--mock-decision',
    'rejected',
  ]));
  assert.equal(rejected.decision, 'deny');

  const timedOut = parseOnlyJsonLine(runCli([
    'antigravity-hook',
    'PreToolUse',
    '--fixture',
    'fixtures/antigravity/pretool-run-command.json',
    '--adapter',
    'mock',
    '--mock-decision',
    'timeout',
    '--fallback',
    'deny',
  ]));
  assert.equal(timedOut.decision, 'deny');
  assert.match(timedOut.reason, /timed out|timeout/i);

  const malformed = parseOnlyJsonLine(runCli([
    'antigravity-hook',
    'PreToolUse',
    '--fixture',
    'fixtures/antigravity/malformed-missing-toolcall.json',
    '--adapter',
    'mock',
    '--mock-decision',
    'approved',
  ]));
  assert.equal(malformed.decision, 'deny');
  assert.match(malformed.reason, /invalid/i);

  const postTool = parseOnlyJsonLine(runCli([
    'antigravity-hook',
    'PostToolUse',
    '--fixture',
    'fixtures/antigravity/posttool-error.json',
    '--adapter',
    'mock',
    '--mock-decision',
    'approved',
  ]));
  assert.deepEqual(postTool, {});

  const strictPreInvocation = parseOnlyJsonLine(runCli([
    'antigravity-hook',
    'PreInvocation',
    '--profile',
    'strict',
  ], {
    input: JSON.stringify({
      invocationNum: 1,
      initialNumSteps: 3,
      conversationId: '00000000-0000-0000-0000-000000000000',
      workspacePaths: ['/workspace/demo-app'],
    }),
  }));
  assert.equal(strictPreInvocation.injectSteps.length, 1);
  assert.match(strictPreInvocation.injectSteps[0].ephemeralMessage, /Orbiter approval gate is active/);
});

test('Antigravity setup, doctor, and uninstall manage workspace hooks.json safely', () => {
  const workspace = mkTempDir('orbiter-antigravity-hooks-');

  const setup = parseJsonStdout(runCli([
    'antigravity',
    'setup',
    '--workspace',
    workspace,
    '--adapter',
    'mock',
    '--mock-decision',
    'approved',
    '--profile',
    'blocking',
    '--fallback',
    'deny',
  ]));
  assert.equal(setup.success, true);
  assert.equal(setup.analysis.ownedHookPresent, true);
  assert.equal(setup.analysis.matcher, '*');
  assert.equal(setup.analysis.timeoutSeconds, 300);

  const configPath = path.join(workspace, '.agents', 'hooks.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const owned = config['orbiter-approval-gate'];
  assert.equal(owned.enabled, true);
  assert.equal(owned.PreToolUse[0].matcher, '*');
  assert.match(owned.PreToolUse[0].hooks[0].command, /node orbiter-antigravity-hook\.cjs antigravity-hook PreToolUse/);
  assert.match(owned.PostToolUse[0].hooks[0].command, /node orbiter-antigravity-hook\.cjs antigravity-hook PostToolUse/);
  assert.match(owned.PreInvocation[0].command, /node orbiter-antigravity-hook\.cjs antigravity-hook PreInvocation/);
  assert.match(owned.PostInvocation[0].command, /node orbiter-antigravity-hook\.cjs antigravity-hook PostInvocation/);
  assert.match(owned.Stop[0].command, /node orbiter-antigravity-hook\.cjs antigravity-hook Stop/);
  for (const command of [
    owned.PreToolUse[0].hooks[0].command,
    owned.PostToolUse[0].hooks[0].command,
    owned.PreInvocation[0].command,
    owned.PostInvocation[0].command,
    owned.Stop[0].command,
  ]) {
    assert.doesNotMatch(command, /"/);
    assert.doesNotMatch(command, /dist[\\/]index\.js/);
  }

  const runnerPath = path.join(workspace, '.agents', 'orbiter-antigravity-hook.cjs');
  assert.equal(fs.existsSync(runnerPath), true);
  assert.match(fs.readFileSync(runnerPath, 'utf8'), /dist.*index\.js/);

  const preInvocationCommand = owned.PreInvocation[0].command.split(/\s+/);
  const preInvocation = spawnSync(preInvocationCommand[0], preInvocationCommand.slice(1), {
    cwd: path.join(workspace, '.agents'),
    env: { ...process.env, ORBITER_CODEX_IDEMPOTENCY_STORE: path.join(os.tmpdir(), 'orbiter-agy-runner-idempotency.json') },
    input: JSON.stringify({
      invocationNum: 1,
      initialNumSteps: 1,
      conversationId: '00000000-0000-0000-0000-000000000000',
      workspacePaths: [workspace],
    }),
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(preInvocation.status, 0, preInvocation.stderr);
  assert.equal(preInvocation.stdout.trim(), '{}');

  const doctor = parseJsonStdout(runCli([
    'antigravity',
    'doctor',
    '--workspace',
    workspace,
    '--adapter',
    'mock',
    '--mock-decision',
    'approved',
  ]));
  assert.equal(doctor.success, true);
  assert.deepEqual(doctor.checks.map((check) => [check.name, check.ok]), doctor.checks.map((check) => [check.name, true]));

  const uninstall = parseJsonStdout(runCli([
    'antigravity',
    'uninstall',
    '--workspace',
    workspace,
  ]));
  assert.equal(uninstall.success, true);
  assert.equal(uninstall.analysis.ownedHookPresent, false);
  assert.equal(fs.existsSync(configPath), false);
  assert.equal(fs.existsSync(runnerPath), false);
});

test('Antigravity doctor --check-backend reports backend health failures', () => {
  const workspace = mkTempDir('orbiter-antigravity-backend-doctor-');

  parseJsonStdout(runCli([
    'antigravity',
    'setup',
    '--workspace',
    workspace,
    '--adapter',
    'mock',
    '--mock-decision',
    'approved',
  ]));

  const doctor = runCli([
    'antigravity',
    'doctor',
    '--workspace',
    workspace,
    '--check-backend',
    '--server-url',
    'http://127.0.0.1:1',
  ]);

  assert.equal(doctor.status, 1, doctor.stderr);
  const output = JSON.parse(doctor.stdout);
  const backendHealth = output.checks.find((check) => check.name === 'backend_health');
  assert.ok(backendHealth, 'expected backend_health check when --check-backend is passed');
  assert.equal(backendHealth.ok, false);
});

test('Antigravity setup can align native command policy for Orbiter-gated execution', () => {
  const workspace = mkTempDir('orbiter-antigravity-native-');
  const projectsDir = mkTempDir('orbiter-antigravity-projects-');
  const projectConfigPath = path.join(projectsDir, 'project.json');
  const folderUri = `file:///${workspace.replace(/\\/g, '/').replace(':', '%3A')}`;
  fs.writeFileSync(projectConfigPath, JSON.stringify({
    id: 'project-native-test',
    name: 'native_test',
    projectResources: {
      resources: [
        {
          gitFolder: {
            folderUri,
          },
        },
      ],
    },
    settings: {
      autoExecutionPolicy: 'CASCADE_COMMANDS_AUTO_EXECUTION_OFF',
    },
  }, null, 2));

  const env = { ORBITER_ANTIGRAVITY_PROJECTS_DIR: projectsDir };
  const beforeDoctor = runCli([
    'antigravity',
    'doctor',
    '--workspace',
    workspace,
    '--adapter',
    'mock',
    '--mock-decision',
    'approved',
  ], { env });
  assert.equal(beforeDoctor.status, 1, beforeDoctor.stderr);
  const beforeDoctorJson = JSON.parse(beforeDoctor.stdout);
  assert.equal(beforeDoctorJson.nativeCommandPolicy.readyForOrbiterGate, false);

  const setup = parseJsonStdout(runCli([
    'antigravity',
    'setup',
    '--workspace',
    workspace,
    '--adapter',
    'mock',
    '--mock-decision',
    'approved',
    '--configure-native-command-policy',
  ], { env }));
  assert.equal(setup.success, true);
  assert.equal(setup.nativeCommandPolicy.readyForOrbiterGate, true);
  assert.equal(setup.nativeCommandPolicy.changed, true);
  assert.equal(fs.existsSync(setup.nativeCommandPolicy.backupPath), true);

  const projectConfig = JSON.parse(fs.readFileSync(projectConfigPath, 'utf8'));
  assert.equal(projectConfig.settings.autoExecutionPolicy, 'CASCADE_COMMANDS_AUTO_EXECUTION_EAGER');

  const afterDoctor = parseJsonStdout(runCli([
    'antigravity',
    'doctor',
    '--workspace',
    workspace,
    '--adapter',
    'mock',
    '--mock-decision',
    'approved',
  ], { env }));
  assert.equal(afterDoctor.nativeCommandPolicy.readyForOrbiterGate, true);
});

test('Claude Code plugin ships a single enforced synchronous PermissionRequest gate', (t) => {
  // v1.1.x replaced the legacy orbiter-bridge 7-hook settings.json with a single
  // enforced PermissionRequest hook in hooks/hooks.json (auto-loaded by convention).
  const hooksPath = path.join(packageRoot, 'orbiter-plugin', 'hooks', 'hooks.json');
  if (!fs.existsSync(hooksPath)) {
    t.skip('orbiter-plugin lives in orbiterdev-ai/orbiter-plugin in standalone exports');
    return;
  }
  const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8')).hooks;

  assert.ok(Array.isArray(hooks.PermissionRequest), 'PermissionRequest should be configured');
  assert.deepEqual(Object.keys(hooks), ['PermissionRequest'], 'only PermissionRequest should be declared');
  assert.equal(hooks.PermissionRequest[0].matcher, '*', 'the gate must cover every permissioned tool');

  const permissionRequest = hooks.PermissionRequest[0].hooks[0];
  assert.equal(permissionRequest.type, 'command');
  assert.match(permissionRequest.command, /orbiter-plugin-hook\.cjs/);
  assert.match(permissionRequest.command, /permission-check/);
  // Blocking, not fire-and-forget: an async hook could not return a decision.
  assert.equal(Object.hasOwn(permissionRequest, 'async'), false);
  assert.equal(permissionRequest.env.ORBITER_SERVER_URL, 'https://api.orbiterdev.ai');
  assert.equal(permissionRequest.env.ORBITER_CREDENTIAL_PROFILE, 'claude-code');
});

test('Claude Code plugin manifest must NOT declare hooks (duplicate-load regression)', (t) => {
  // Declaring `hooks` in plugin.json double-loads hooks/hooks.json and the plugin
  // fails with "Duplicate hooks file detected" (found and fixed 2026-07-19, v1.1.1).
  const manifestPath = path.join(packageRoot, 'orbiter-plugin', '.claude-plugin', 'plugin.json');
  if (!fs.existsSync(manifestPath)) {
    t.skip('orbiter-plugin lives in orbiterdev-ai/orbiter-plugin in standalone exports');
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(Object.hasOwn(manifest, 'hooks'), false, 'plugin.json must not declare hooks');
  assert.ok(manifest.version, 'plugin manifest needs a version');
});

test('Claude setup and doctor manage project hooks without localhost defaults', () => {
  const workspace = mkTempDir('orbiter-claude-hooks-');
  const credentialsPath = path.join(workspace, 'credentials.json');
  fs.writeFileSync(credentialsPath, JSON.stringify({
    api_key: 'orb_sk_test_key',
    user_id: '00000000-0000-0000-0000-000000000000',
    paired_at: '2026-06-19T18:00:00.000Z',
    backend_url: 'https://api.orbiterdev.ai',
  }, null, 2));

  const setup = parseJsonStdout(runCli([
    'claude',
    'setup',
    '--scope',
    'project',
    '--workspace',
    workspace,
    '--server-url',
    'https://api.orbiterdev.ai',
  ]));
  assert.equal(setup.success, true);
  assert.equal(setup.analysis.hasPermissionRequestHook, true);
  assert.equal(setup.analysis.hasOrbiterMcpServer, true);
  assert.equal(setup.analysis.backendMode, 'live-http');

  const settingsPath = path.join(workspace, '.claude', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const hook = settings.hooks.PermissionRequest[0].hooks[0];
  assert.match(hook.command, /permission-check/);
  assert.equal(hook.env.ORBITER_SERVER_URL, 'https://api.orbiterdev.ai');
  assert.doesNotMatch(JSON.stringify(settings), /127\.0\.0\.1|localhost/);

  // stable-edge: the trusted hook command targets the stable .claude runner, NOT the volatile
  // npm package path - so an npm update never rewrites the trusted command (no re-trust prompt).
  assert.match(hook.command, /orbiter-claude-hook\.cjs/);
  assert.doesNotMatch(hook.command, /dist[\\/]index\.js/);
  const claudeRunnerPath = path.join(workspace, '.claude', 'orbiter-claude-hook.cjs');
  assert.equal(fs.existsSync(claudeRunnerPath), true);
  // the volatile package path is isolated inside the runner, which is regenerated each setup
  assert.match(fs.readFileSync(claudeRunnerPath, 'utf8'), /dist.*index\.js/);

  const doctor = parseJsonStdout(runCli([
    'claude',
    'doctor',
    '--scope',
    'project',
    '--workspace',
    workspace,
  ], { env: { ORBITER_CREDENTIAL_PATH: credentialsPath } }));
  assert.equal(doctor.success, true);
  assert.equal(doctor.sessionApprovalCache.behavior, 'new Claude sessions may be required after hook changes');
  assert.deepEqual(doctor.checks.map((check) => [check.name, check.ok]), doctor.checks.map((check) => [check.name, true]));
});

test('Claude doctor --check-backend reports backend health failures', () => {
  const workspace = mkTempDir('orbiter-claude-backend-doctor-');

  parseJsonStdout(runCli([
    'claude',
    'setup',
    '--scope',
    'project',
    '--workspace',
    workspace,
    '--server-url',
    'https://api.orbiterdev.ai',
  ]));

  const doctor = runCli([
    'claude',
    'doctor',
    '--scope',
    'project',
    '--workspace',
    workspace,
    '--check-backend',
    '--server-url',
    'http://127.0.0.1:1',
  ]);

  assert.equal(doctor.status, 1, doctor.stderr);
  const output = JSON.parse(doctor.stdout);
  const backendHealth = output.checks.find((check) => check.name === 'backend_health');
  assert.ok(backendHealth, 'expected backend_health check when --check-backend is passed');
  assert.equal(backendHealth.ok, false);
});

test('Claude Code bridge safe fixtures emit clean blocking-hook JSON without backend access', (t) => {
  if (!fs.existsSync(path.join(bridgeDist, 'pre-check.js'))) {
    t.skip('orbiter-bridge lives in orbiterdev-ai/orbiter-bridge in standalone exports');
    return;
  }
  const preToolUse = parseOnlyJsonLine(runNode([
    path.join(bridgeDist, 'pre-check.js'),
  ], {
    cwd: bridgeRoot,
    input: readFixture('claude-code/pretool-safe.json'),
  }));
  assert.equal(preToolUse.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(preToolUse.hookSpecificOutput.permissionDecision, 'allow');

  const permissionRequest = parseOnlyJsonLine(runNode([
    path.join(bridgeDist, 'permission-request-hook.js'),
  ], {
    cwd: bridgeRoot,
    input: readFixture('claude-code/permission-request-safe.json'),
  }));
  assert.equal(permissionRequest.hookSpecificOutput.hookEventName, 'PermissionRequest');
  assert.equal(permissionRequest.hookSpecificOutput.decision.behavior, 'allow');

  const autoModePreToolUse = parseOnlyJsonLine(runNode([
    path.join(bridgeDist, 'pre-check.js'),
  ], {
    cwd: bridgeRoot,
    input: JSON.stringify({
      session_id: 'claude-auto-mode-session',
      transcript_path: path.join(packageRoot, 'tmp', 'claude-auto-mode.jsonl'),
      cwd: packageRoot,
      permission_mode: 'auto',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: {
        command: 'git status --short',
      },
    }),
  }));
  assert.equal(autoModePreToolUse.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(autoModePreToolUse.hookSpecificOutput.permissionDecision, 'allow');
});

test('Gemini CLI hook denies rejected risky BeforeTool fixture with structured JSON', () => {
  const output = parseOnlyJsonLine(runCli([
    'gemini-hook',
    'BeforeTool',
    '--fixture',
    'fixtures/gemini-cli/beforetool-run-shell-critical.json',
    '--adapter',
    'mock',
    '--mock-decision',
    'rejected',
  ]));

  assert.equal(output.decision, 'deny');
  assert.match(output.reason, /rejected|git reset|Orbiter/i);
});

test('Gemini CLI hook allows approved high-risk BeforeTool fixture', () => {
  const output = parseOnlyJsonLine(runCli([
    'gemini-hook',
    'BeforeTool',
    '--fixture',
    'fixtures/gemini-cli/beforetool-run-shell-high.json',
    '--adapter',
    'mock',
    '--mock-decision',
    'approved',
  ]));

  assert.equal(output.decision, 'allow');
  assert.match(output.systemMessage || '', /Orbiter/i);
});

test('Gemini CLI setup, doctor, and uninstall manage workspace settings safely', () => {
  const workspace = mkTempDir('orbiter-gemini-hooks-');

  const setup = parseJsonStdout(runCli([
    'gemini',
    'setup',
    '--workspace',
    workspace,
    '--adapter',
    'mock',
    '--mock-decision',
    'approved',
    '--profile',
    'guarded',
  ]));
  assert.equal(setup.success, true);
  assert.equal(setup.analysis.ownedBeforeToolHookCount, 1);
  assert.equal(setup.analysis.ownedAfterToolHookCount, 1);
  assert.equal(setup.analysis.hasOrbiterMcpServer, true);

  const settingsPath = path.join(workspace, '.gemini', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(settings.mcpServers['orbiter-dev'].command, 'node');
  assert.deepEqual(settings.mcpServers['orbiter-dev'].args, [cliPath]);
  assert.match(settings.hooks.BeforeTool[0].hooks[0].command, /orbiter-gemini-hook\.cjs gemini-hook BeforeTool/);
  assert.match(settings.hooks.AfterTool[0].hooks[0].command, /orbiter-gemini-hook\.cjs gemini-hook AfterTool/);

  const runnerPath = path.join(workspace, '.gemini', 'hooks', 'orbiter-gemini-hook.cjs');
  assert.equal(fs.existsSync(runnerPath), true);
  assert.match(fs.readFileSync(runnerPath, 'utf8'), /dist.*index\.js/);

  const doctor = parseJsonStdout(runCli([
    'gemini',
    'doctor',
    '--workspace',
    workspace,
    '--adapter',
    'mock',
    '--mock-decision',
    'approved',
  ]));
  assert.equal(doctor.success, true);
  assert.deepEqual(doctor.checks.map((check) => [check.name, check.ok]), doctor.checks.map((check) => [check.name, true]));

  const uninstall = parseJsonStdout(runCli([
    'gemini',
    'uninstall',
    '--workspace',
    workspace,
  ]));
  assert.equal(uninstall.success, true);
  assert.equal(uninstall.analysis.hasOwnedHooks, false);
  assert.equal(uninstall.analysis.hasOrbiterMcpServer, false);
});

test('Gemini CLI doctor --check-backend reports backend health failures', () => {
  const workspace = mkTempDir('orbiter-gemini-backend-doctor-');

  parseJsonStdout(runCli([
    'gemini',
    'setup',
    '--workspace',
    workspace,
    '--adapter',
    'mock',
    '--mock-decision',
    'approved',
  ]));

  const doctor = runCli([
    'gemini',
    'doctor',
    '--workspace',
    workspace,
    '--check-backend',
    '--server-url',
    'http://127.0.0.1:1',
  ]);

  assert.equal(doctor.status, 1, doctor.stderr);
  const output = JSON.parse(doctor.stdout);
  const backendHealth = output.checks.find((check) => check.name === 'backend_health');
  assert.ok(backendHealth, 'expected backend_health check when --check-backend is passed');
  assert.equal(backendHealth.ok, false);
});

test('Claude Code bridge malformed PreToolUse input falls back to ask instead of silent allow', (t) => {
  if (!fs.existsSync(path.join(bridgeDist, 'pre-check.js'))) {
    t.skip('orbiter-bridge lives in orbiterdev-ai/orbiter-bridge in standalone exports');
    return;
  }
  const output = parseOnlyJsonLine(runNode([
    path.join(bridgeDist, 'pre-check.js'),
  ], {
    cwd: bridgeRoot,
    input: '{"tool_name":',
  }));

  assert.equal(output.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(output.hookSpecificOutput.permissionDecision, 'ask');
});

test('hook fixtures avoid credential-shaped payloads', () => {
  const fixturesRoot = path.join(packageRoot, 'fixtures');
  const files = listJsonFiles(fixturesRoot);
  assert.ok(files.length >= 1);

  const secretLike = /(sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{20,}|ghp_[0-9A-Za-z]{20,}|xox[baprs]-[0-9A-Za-z-]{20,})/;
  for (const file of files) {
    const content = fs.readFileSync(path.join(fixturesRoot, file), 'utf8');
    assert.doesNotMatch(content, secretLike, `${file} should not contain credential-shaped text`);
  }
});
