const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const packageRoot = path.resolve(__dirname, '..');
const cliPath = path.join(packageRoot, 'dist', 'index.js');
const impossibleServerUrl = 'https://should-not-be-called.invalid';

function runCli(args, options = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: packageRoot,
    env: {
      ...process.env,
      ORBITER_SERVER_URL: impossibleServerUrl,
      ORBITER_CODEX_REPORT_TELEMETRY: 'true',
      ORBITER_ANTIGRAVITY_REPORT_TELEMETRY: 'true',
      ORBITER_CODEX_IDEMPOTENCY_STORE: path.join(os.tmpdir(), 'orbiter-capture-idempotency.json'),
      ...options.env,
    },
    input: options.input,
    encoding: 'utf8',
    timeout: options.timeout || 15000,
  });
  if (result.error) throw result.error;
  assert.doesNotMatch(result.stdout, /api\.orbiterdev\.ai/);
  assert.doesNotMatch(result.stderr, /api\.orbiterdev\.ai/);
  return result;
}

function parseOnlyJsonLine(result) {
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, `expected exactly one JSON line, got ${lines.length}: ${result.stdout}`);
  return JSON.parse(lines[0]);
}

function parseJsonStdout(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.trim().length > 0, 'expected stdout JSON');
  return JSON.parse(result.stdout);
}

function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readLatestReceipt(captureDir, provider, event) {
  const receiptDir = path.join(captureDir, provider, event);
  assert.equal(fs.existsSync(receiptDir), true, `missing capture receipt dir: ${receiptDir}`);
  const files = fs.readdirSync(receiptDir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => path.join(receiptDir, file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  assert.ok(files.length > 0, `missing capture receipt in ${receiptDir}`);
  return JSON.parse(fs.readFileSync(files[0], 'utf8'));
}

function assertBackendFreeReceipt(receipt, { provider, event, adapter, decision }) {
  assert.equal(receipt.provider, provider);
  assert.equal(receipt.event, event);
  assert.equal(receipt.adapter, adapter);
  assert.equal(receipt.decision_scenario, decision);
  assert.equal(receipt.backend_used, false);
  assert.match(receipt.captured_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(receipt.raw_payload_redacted && typeof receipt.raw_payload_redacted === 'object');
  assert.ok(receipt.hook_output && typeof receipt.hook_output === 'object');
  assert.equal(typeof receipt.stdout_returned_to_ide, 'string');
}

for (const decision of ['approved', 'rejected', 'timeout']) {
  test(`offline capture records Codex ${decision} hook output without backend`, () => {
    const captureDir = mkTempDir('orbiter-codex-capture-');
    const stdout = parseOnlyJsonLine(runCli([
      'codex-hook',
      '--fixture',
      'fixtures/codex/permission-request.json',
      '--capture-dir',
      captureDir,
      '--adapter',
      'mock',
      '--mock-decision',
      decision,
    ]));
    const receipt = readLatestReceipt(captureDir, 'codex', 'PermissionRequest');

    assertBackendFreeReceipt(receipt, {
      provider: 'codex',
      event: 'PermissionRequest',
      adapter: 'mock',
      decision,
    });
    assert.deepEqual(receipt.hook_output, stdout);
    assert.equal(receipt.stdout_returned_to_ide, `${JSON.stringify(stdout)}\n`);
    assert.equal(receipt.secret_scan_passed, true);
    assert.equal(receipt.normalized_approval_request.source_ide, 'codex');
  });

  test(`offline capture records Antigravity ${decision} hook output without backend`, () => {
    const captureDir = mkTempDir('orbiter-antigravity-capture-');
    const stdout = parseOnlyJsonLine(runCli([
      'antigravity-hook',
      'PreToolUse',
      '--fixture',
      'fixtures/antigravity/pretool-run-command.json',
      '--capture-dir',
      captureDir,
      '--adapter',
      'mock',
      '--mock-decision',
      decision,
    ]));
    const receipt = readLatestReceipt(captureDir, 'antigravity', 'PreToolUse');

    assertBackendFreeReceipt(receipt, {
      provider: 'antigravity',
      event: 'PreToolUse',
      adapter: 'mock',
      decision,
    });
    assert.deepEqual(receipt.hook_output, stdout);
    assert.equal(receipt.secret_scan_passed, true);
    assert.equal(receipt.normalized_approval_request.source_ide, 'antigravity');
  });

  test(`offline capture records Gemini CLI ${decision} hook output without backend`, () => {
    const captureDir = mkTempDir('orbiter-gemini-capture-');
    const stdout = parseOnlyJsonLine(runCli([
      'gemini-hook',
      'BeforeTool',
      '--fixture',
      'fixtures/gemini-cli/beforetool-run-shell-high.json',
      '--capture-dir',
      captureDir,
      '--adapter',
      'mock',
      '--mock-decision',
      decision,
    ]));
    const receipt = readLatestReceipt(captureDir, 'gemini', 'BeforeTool');

    assertBackendFreeReceipt(receipt, {
      provider: 'gemini',
      event: 'BeforeTool',
      adapter: 'mock',
      decision,
    });
    assert.deepEqual(receipt.hook_output, stdout);
    assert.equal(receipt.secret_scan_passed, true);
    assert.equal(receipt.normalized_approval_request.source_ide, 'gemini_cli');
  });
}

test('offline capture writes a fail-closed receipt for malformed Antigravity payloads', () => {
  const captureDir = mkTempDir('orbiter-malformed-capture-');
  const stdout = parseOnlyJsonLine(runCli([
    'antigravity-hook',
    'PreToolUse',
    '--capture-dir',
    captureDir,
    '--adapter',
    'mock',
    '--mock-decision',
    'approved',
  ], {
    input: JSON.stringify({
      conversationId: '00000000-0000-0000-0000-000000000000',
      workspacePaths: ['/workspace/demo-app'],
    }),
  }));

  assert.equal(stdout.decision, 'deny');
  const receipt = readLatestReceipt(captureDir, 'antigravity', 'PreToolUse');
  assertBackendFreeReceipt(receipt, {
    provider: 'antigravity',
    event: 'PreToolUse',
    adapter: 'mock',
    decision: 'approved',
  });
  assert.equal(receipt.backend_used, false);
});

test('offline capture redacts credential-shaped payloads and fails closed', () => {
  const captureDir = mkTempDir('orbiter-secret-capture-');
  const credential = ['sk', 'capture', 'OFFLINE', '20260614', 'ABCDEFGHIJKLMNOPQRSTUVWX'].join('-');
  const stdout = parseOnlyJsonLine(runCli([
    'antigravity-hook',
    'PreToolUse',
    '--capture-dir',
    captureDir,
    '--adapter',
    'mock',
    '--mock-decision',
    'approved',
  ], {
    input: JSON.stringify({
      toolCall: {
        name: 'run_command',
        args: {
          CommandLine: `npm publish --otp ${credential}`,
          Cwd: '/workspace/demo-app',
        },
      },
      stepIdx: 42,
      conversationId: '00000000-0000-0000-0000-000000000000',
      workspacePaths: ['/workspace/demo-app'],
    }),
  }));

  assert.equal(stdout.decision, 'deny');
  const receipt = readLatestReceipt(captureDir, 'antigravity', 'PreToolUse');
  const receiptText = JSON.stringify(receipt);
  assert.equal(receipt.secret_scan_passed, false);
  assert.doesNotMatch(receiptText, new RegExp(credential.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(receiptText, /\[REDACTED/);
});

test('offline capture allows benign slash-delimited artifact paths', () => {
  const captureDir = mkTempDir('orbiter-path-capture-');
  const stdout = parseOnlyJsonLine(runCli([
    'antigravity-hook',
    'PreToolUse',
    '--capture-dir',
    captureDir,
    '--adapter',
    'mock',
    '--mock-decision',
    'approved',
  ], {
    input: JSON.stringify({
      artifactDirectoryPath: 'C:/Users/developer/.gemini/antigravity/brain/00000000-0000-0000-0000-000000000000',
      conversationId: '00000000-0000-0000-0000-000000000000',
      toolCall: {
        name: 'write_to_file',
        args: {
          CodeContent: 'The electricity lambda at `aws-backup/exports/2026-01-16_16-27-39/lambda/code/demo-service-get-data-hist/lambda_function.py` fails on uneven phase arrays.',
          Description: 'Updated implementation plan with the bug fix strategy',
          Overwrite: true,
        },
      },
      workspacePaths: ['/workspace/demo-app'],
    }),
  }));

  assert.equal(stdout.decision, 'allow');
  const receipt = readLatestReceipt(captureDir, 'antigravity', 'PreToolUse');
  const receiptText = JSON.stringify(receipt);
  assert.equal(receipt.secret_scan_passed, true);
  assert.match(receiptText, /aws-backup/);
  assert.doesNotMatch(receiptText, /C:\/Users\/developer/);
  assert.match(receiptText, /C:\/Users\/\[REDACTED:user\]/);
});

test('offline setup profiles generate capture commands and doctor reports backend mode', () => {
  const captureDir = mkTempDir('orbiter-offline-profile-captures-');

  const codexHome = mkTempDir('orbiter-codex-offline-home-');
  const codexSetup = parseJsonStdout(runCli([
    'codex',
    'setup',
    '--codex-home',
    codexHome,
    '--offline-capture',
    '--capture-dir',
    captureDir,
    '--adapter',
    'mock',
    '--mock-decision',
    'approved',
    '--hook-profile',
    'guarded',
  ]));
  assert.equal(codexSetup.analysis.backendMode, 'offline-capture');
  const codexConfig = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
  assert.match(codexConfig, /--capture-dir/);
  assert.doesNotMatch(codexConfig, /--adapter\s+http/);
  const codexDoctor = parseJsonStdout(runCli(['codex', 'doctor', '--codex-home', codexHome]));
  assert.equal(codexDoctor.analysis.backendMode, 'offline-capture');
  assert.equal(codexDoctor.analysis.mockDecision, 'approved');
  const codexRoundtrip = codexDoctor.checks.find((check) => check.name === 'permission_request_mock_roundtrip');
  assert.equal(codexRoundtrip.ok, true);
  assert.match(codexRoundtrip.detail, /"mockDecision":"approved"/);

  const codexRejectedHome = mkTempDir('orbiter-codex-rejected-home-');
  const codexRejectedSetup = parseJsonStdout(runCli([
    'codex',
    'setup',
    '--codex-home',
    codexRejectedHome,
    '--offline-capture',
    '--capture-dir',
    captureDir,
    '--adapter',
    'mock',
    '--mock-decision',
    'rejected',
    '--hook-profile',
    'guarded',
  ]));
  assert.equal(codexRejectedSetup.analysis.backendMode, 'offline-capture');
  assert.equal(codexRejectedSetup.analysis.mockDecision, 'rejected');
  const codexRejectedDoctor = parseJsonStdout(runCli(['codex', 'doctor', '--codex-home', codexRejectedHome]));
  assert.equal(codexRejectedDoctor.analysis.backendMode, 'offline-capture');
  assert.equal(codexRejectedDoctor.analysis.mockDecision, 'rejected');
  const codexRejectedRoundtrip = codexRejectedDoctor.checks.find((check) => check.name === 'permission_request_mock_roundtrip');
  assert.equal(codexRejectedRoundtrip.ok, true);
  assert.match(codexRejectedRoundtrip.detail, /"mockDecision":"rejected"/);
  assert.match(codexRejectedRoundtrip.detail, /"behavior":"deny"/);

  const antigravityWorkspace = mkTempDir('orbiter-antigravity-offline-workspace-');
  const antigravitySetup = parseJsonStdout(runCli([
    'antigravity',
    'setup',
    '--workspace',
    antigravityWorkspace,
    '--offline-capture',
    '--capture-dir',
    captureDir,
    '--adapter',
    'mock',
    '--mock-decision',
    'approved',
  ]));
  assert.equal(antigravitySetup.analysis.backendMode, 'offline-capture');
  const antigravityConfig = fs.readFileSync(path.join(antigravityWorkspace, '.agents', 'hooks.json'), 'utf8');
  assert.match(antigravityConfig, /--capture-dir/);
  assert.doesNotMatch(antigravityConfig, /--adapter\s+http/);
  const antigravityDoctor = parseJsonStdout(runCli(['antigravity', 'doctor', '--workspace', antigravityWorkspace]));
  assert.equal(antigravityDoctor.analysis.backendMode, 'offline-capture');

  const antigravityRejectedWorkspace = mkTempDir('orbiter-antigravity-rejected-workspace-');
  const antigravityRejectedSetup = parseJsonStdout(runCli([
    'antigravity',
    'setup',
    '--workspace',
    antigravityRejectedWorkspace,
    '--offline-capture',
    '--capture-dir',
    captureDir,
    '--adapter',
    'mock',
    '--mock-decision',
    'rejected',
  ]));
  assert.equal(antigravityRejectedSetup.analysis.backendMode, 'offline-capture');
  assert.equal(antigravityRejectedSetup.analysis.mockDecision, 'rejected');
  const antigravityRejectedDoctor = parseJsonStdout(runCli([
    'antigravity',
    'doctor',
    '--workspace',
    antigravityRejectedWorkspace,
  ]));
  assert.equal(antigravityRejectedDoctor.analysis.backendMode, 'offline-capture');
  assert.equal(antigravityRejectedDoctor.analysis.mockDecision, 'rejected');
  const rejectedRoundtrip = antigravityRejectedDoctor.checks.find((check) => check.name === 'pretooluse_mock_roundtrip');
  assert.equal(rejectedRoundtrip.ok, true);
  assert.match(rejectedRoundtrip.detail, /"mockDecision":"rejected"/);
  assert.match(rejectedRoundtrip.detail, /"expectedDecision":"deny"/);
  assert.match(rejectedRoundtrip.detail, /"decision":"deny"/);

  const geminiWorkspace = mkTempDir('orbiter-gemini-offline-workspace-');
  const geminiSetup = parseJsonStdout(runCli([
    'gemini',
    'setup',
    '--workspace',
    geminiWorkspace,
    '--offline-capture',
    '--capture-dir',
    captureDir,
    '--adapter',
    'mock',
    '--mock-decision',
    'approved',
  ]));
  assert.equal(geminiSetup.analysis.backendMode, 'offline-capture');
  const geminiSettings = fs.readFileSync(path.join(geminiWorkspace, '.gemini', 'settings.json'), 'utf8');
  assert.match(geminiSettings, /--capture-dir/);
  assert.doesNotMatch(geminiSettings, /--adapter\s+http/);
  const geminiDoctor = parseJsonStdout(runCli(['gemini', 'doctor', '--workspace', geminiWorkspace]));
  assert.equal(geminiDoctor.analysis.backendMode, 'offline-capture');
  assert.equal(geminiDoctor.analysis.mockDecision, 'approved');
  const geminiRoundtrip = geminiDoctor.checks.find((check) => check.name === 'beforetool_mock_roundtrip');
  assert.equal(geminiRoundtrip.ok, true);
  assert.match(geminiRoundtrip.detail, /"mockDecision":"approved"/);

  const geminiRejectedWorkspace = mkTempDir('orbiter-gemini-rejected-workspace-');
  const geminiRejectedSetup = parseJsonStdout(runCli([
    'gemini',
    'setup',
    '--workspace',
    geminiRejectedWorkspace,
    '--offline-capture',
    '--capture-dir',
    captureDir,
    '--adapter',
    'mock',
    '--mock-decision',
    'rejected',
  ]));
  assert.equal(geminiRejectedSetup.analysis.backendMode, 'offline-capture');
  assert.equal(geminiRejectedSetup.analysis.mockDecision, 'rejected');
  const geminiRejectedDoctor = parseJsonStdout(runCli(['gemini', 'doctor', '--workspace', geminiRejectedWorkspace]));
  assert.equal(geminiRejectedDoctor.analysis.backendMode, 'offline-capture');
  assert.equal(geminiRejectedDoctor.analysis.mockDecision, 'rejected');
  const geminiRejectedRoundtrip = geminiRejectedDoctor.checks.find((check) => check.name === 'beforetool_mock_roundtrip');
  assert.equal(geminiRejectedRoundtrip.ok, true);
  assert.match(geminiRejectedRoundtrip.detail, /"mockDecision":"rejected"/);
  assert.match(geminiRejectedRoundtrip.detail, /"decision":"deny"/);
});
