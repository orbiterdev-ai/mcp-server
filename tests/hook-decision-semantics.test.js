const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Decision-semantics contract across surfaces (2026-07-01 unification):
//   1. Critical risk routes to the PHONE by default on every surface ("the phone stays
//      the only approver"); `criticalMode: 'deny'` restores the local hard-deny.
//   2. An explicit user rejection always denies. The `fallback` option governs only
//      INCOMPLETE decisions (timeout / adapter failure / pending).
//   3. Antigravity 'observe' profile is log-only: it never blocks, including critical.
//   4. The idempotency cache never replays a transport failure as a decision.
//   5. Handlers do not mutate process.env from their options (no hidden global state).

function pick(mod, name) {
  if (mod[name] !== undefined) return mod[name];
  if (mod.default && mod.default[name] !== undefined) return mod.default[name];
  return undefined;
}

async function load() {
  const codex = await import('../dist/codex/hooks.js');
  const gemini = await import('../dist/gemini/hooks.js');
  const antigravity = await import('../dist/antigravity/hooks.js');
  const idempotency = await import('../dist/codex/idempotency.js');
  return {
    handleCodexHook: pick(codex, 'handleCodexHook'),
    handleGeminiHook: pick(gemini, 'handleGeminiHook'),
    handleAntigravityHook: pick(antigravity, 'handleAntigravityHook'),
    readCachedCodexDecision: pick(idempotency, 'readCachedCodexDecision'),
    writeCachedCodexDecision: pick(idempotency, 'writeCachedCodexDecision'),
  };
}

const CRITICAL_COMMAND = 'rm -rf / --no-preserve-root';

function codexPreToolUse(command) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'shell',
    tool_input: { command },
    session_id: `sess-${Math.random().toString(36).slice(2)}`,
    turn_id: 'turn-1',
    tool_use_id: 'use-1',
    cwd: process.cwd(),
  };
}

function geminiBeforeTool(command) {
  return {
    hook_event_name: 'BeforeTool',
    tool_name: 'run_shell_command',
    tool_input: { command },
    session_id: `sess-${Math.random().toString(36).slice(2)}`,
    cwd: process.cwd(),
  };
}

function antigravityPreToolUse(command) {
  return {
    conversationId: `conv-${Math.random().toString(36).slice(2)}`,
    stepIdx: 1,
    workspacePaths: [process.cwd()],
    toolCall: { name: 'run_command', args: { CommandLine: command, Cwd: process.cwd() } },
  };
}

test('critical routes to the phone by default and can be approved (codex/gemini/antigravity)', async () => {
  const { handleCodexHook, handleGeminiHook, handleAntigravityHook } = await load();

  const codex = await handleCodexHook(codexPreToolUse(CRITICAL_COMMAND), { adapter: 'mock', mockDecision: 'approved' });
  assert.equal(codex.normalized.risk, 'critical');
  assert.ok(codex.decision, 'codex critical must request a decision');
  assert.deepEqual(codex.output, {}, 'approved critical proceeds');

  const gemini = await handleGeminiHook(geminiBeforeTool(CRITICAL_COMMAND), { adapter: 'mock', mockDecision: 'approved' });
  assert.equal(gemini.normalized.risk, 'critical');
  assert.ok(gemini.decision, 'gemini critical must request a decision');
  assert.equal(gemini.output.decision, 'allow');

  const antigravity = await handleAntigravityHook(antigravityPreToolUse(CRITICAL_COMMAND), {
    eventName: 'PreToolUse',
    profile: 'blocking',
    adapter: 'mock',
    mockDecision: 'approved',
  });
  assert.equal(antigravity.normalized.risk.level, 'critical');
  assert.ok(antigravity.decision, 'antigravity critical must request a decision');
  assert.equal(antigravity.output.decision, 'allow');
});

test('critical denial still denies, and criticalMode=deny restores the local hard-deny', async () => {
  const { handleCodexHook, handleGeminiHook, handleAntigravityHook } = await load();

  const rejected = await handleCodexHook(codexPreToolUse(CRITICAL_COMMAND), { adapter: 'mock', mockDecision: 'rejected' });
  assert.equal(rejected.output.hookSpecificOutput.permissionDecision, 'deny');

  const codexDeny = await handleCodexHook(codexPreToolUse(CRITICAL_COMMAND), { adapter: 'mock', mockDecision: 'approved', criticalMode: 'deny' });
  assert.equal(codexDeny.decision, undefined, 'criticalMode=deny must not contact the adapter');
  assert.equal(codexDeny.output.hookSpecificOutput.permissionDecision, 'deny');

  const geminiDeny = await handleGeminiHook(geminiBeforeTool(CRITICAL_COMMAND), { adapter: 'mock', mockDecision: 'approved', criticalMode: 'deny' });
  assert.equal(geminiDeny.decision, undefined);
  assert.equal(geminiDeny.output.decision, 'deny');

  const antigravityDeny = await handleAntigravityHook(antigravityPreToolUse(CRITICAL_COMMAND), {
    eventName: 'PreToolUse',
    profile: 'blocking',
    adapter: 'mock',
    mockDecision: 'approved',
    criticalMode: 'deny',
  });
  assert.equal(antigravityDeny.decision, undefined);
  assert.equal(antigravityDeny.output.decision, 'deny');
});

test('fallback governs incomplete decisions only; rejection always denies', async () => {
  const { handleCodexHook, handleGeminiHook } = await load();

  // Timeout + default fallback -> deny (fail closed).
  const timedOut = await handleCodexHook(codexPreToolUse('git push origin main'), { adapter: 'mock', mockDecision: 'timeout' });
  assert.equal(timedOut.output.hookSpecificOutput.permissionDecision, 'deny');

  // Timeout + fallback allow -> proceed (fail open, configured).
  const failOpen = await handleCodexHook(codexPreToolUse('git push origin main'), { adapter: 'mock', mockDecision: 'timeout', fallback: 'allow' });
  assert.deepEqual(failOpen.output, {});

  // Rejection + fallback allow -> STILL deny (explicit verdicts are never overridden).
  const rejectedAnyway = await handleCodexHook(codexPreToolUse('git push origin main'), { adapter: 'mock', mockDecision: 'rejected', fallback: 'allow' });
  assert.equal(rejectedAnyway.output.hookSpecificOutput.permissionDecision, 'deny');

  const geminiFailOpen = await handleGeminiHook(geminiBeforeTool('git push origin main'), { adapter: 'mock', mockDecision: 'timeout', fallback: 'allow' });
  assert.equal(geminiFailOpen.output.decision, 'allow');
  const geminiRejected = await handleGeminiHook(geminiBeforeTool('git push origin main'), { adapter: 'mock', mockDecision: 'rejected', fallback: 'allow' });
  assert.equal(geminiRejected.output.decision, 'deny');
});

test('antigravity observe profile is log-only: critical is allowed with the risk noted', async () => {
  const { handleAntigravityHook } = await load();
  const result = await handleAntigravityHook(antigravityPreToolUse(CRITICAL_COMMAND), {
    eventName: 'PreToolUse',
    profile: 'observe',
    adapter: 'mock',
    mockDecision: 'rejected',
  });
  assert.equal(result.decision, undefined, 'observe must not request approval');
  assert.equal(result.output.decision, 'allow');
  assert.match(result.output.reason, /critical risk noted/i);
});

test('idempotency cache never stores or replays non-verdict decisions', async () => {
  const { readCachedCodexDecision, writeCachedCodexDecision } = await load();
  const store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orbiter-idem-')), 'cache.json');
  process.env.ORBITER_CODEX_IDEMPOTENCY_STORE = store;
  try {
    writeCachedCodexDecision('key-timeout', { status: 'timeout', timedOut: true });
    assert.equal(readCachedCodexDecision('key-timeout'), undefined, 'timeout must not be cached');

    // A poisoned cache written before the fix is ignored on read.
    fs.writeFileSync(store, JSON.stringify({ 'key-poisoned': { status: 'timeout', timedOut: true, cached_at: new Date().toISOString() } }));
    assert.equal(readCachedCodexDecision('key-poisoned'), undefined, 'poisoned timeout entries are healed on read');

    writeCachedCodexDecision('key-approved', { status: 'approved' });
    assert.equal(readCachedCodexDecision('key-approved').status, 'approved');
  } finally {
    delete process.env.ORBITER_CODEX_IDEMPOTENCY_STORE;
  }
});

test('handlers do not leak their options into process.env', async () => {
  const { handleGeminiHook, handleCodexHook, handleAntigravityHook } = await load();
  const before = {
    serverUrl: process.env.ORBITER_SERVER_URL,
    timeout: process.env.ORBITER_CODEX_TIMEOUT_SECONDS,
    adapter: process.env.ORBITER_CODEX_APPROVAL_ADAPTER,
    mock: process.env.ORBITER_CODEX_MOCK_DECISION,
  };

  await handleGeminiHook(geminiBeforeTool('git push origin main'), {
    adapter: 'mock', mockDecision: 'approved', serverUrl: 'https://example.invalid', timeoutSeconds: 7,
  });
  await handleCodexHook(codexPreToolUse('git push origin main'), {
    adapter: 'mock', mockDecision: 'approved', serverUrl: 'https://example.invalid', timeoutSeconds: 7,
  });
  await handleAntigravityHook(antigravityPreToolUse('git push origin main'), {
    eventName: 'PreToolUse', profile: 'blocking', adapter: 'mock', mockDecision: 'approved',
    serverUrl: 'https://example.invalid', timeoutSeconds: 7,
  });

  assert.equal(process.env.ORBITER_SERVER_URL, before.serverUrl);
  assert.equal(process.env.ORBITER_CODEX_TIMEOUT_SECONDS, before.timeout);
  assert.equal(process.env.ORBITER_CODEX_APPROVAL_ADAPTER, before.adapter);
  assert.equal(process.env.ORBITER_CODEX_MOCK_DECISION, before.mock);
});

test('claude surface redacts secrets from tool input before it leaves the machine', async () => {
  const mod = await import('../dist/cli/permissionCheck.js');
  const redactToolInputJson = mod.redactToolInputJson || (mod.default && mod.default.redactToolInputJson);
  assert.ok(redactToolInputJson, 'redactToolInputJson exported');

  const fakeKeyPrefix = ['sk', 'abcdefghijklmnopqrstuvwx'].join('-');
  const fakeKey = `${fakeKeyPrefix}1234`;
  const withSecret = JSON.stringify({
    command: `curl -H "Authorization: Bearer ${fakeKeyPrefix}" https://api.example.com`,
    api_key: fakeKey,
  });
  const redacted = redactToolInputJson(withSecret);
  assert.ok(!redacted.includes(fakeKeyPrefix), 'token value removed');
  assert.ok(redacted.includes('[redacted]'), 'redaction marker present');

  const nonJson = `Bearer ${fakeKeyPrefix} plain text`;
  assert.ok(!redactToolInputJson(nonJson).includes(fakeKeyPrefix));
});
