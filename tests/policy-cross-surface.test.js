const test = require('node:test');
const assert = require('node:assert/strict');

// Cross-surface determinism: the SAME command must receive the SAME risk level no matter
// which integration routes it - the Claude Code permission-check hook / permission relay
// (policy/toolRisk.ts), the Codex hook normalizer, or the Gemini hook normalizer. This is
// the product's core promise ("same action, same rule, same answer") and the regression
// guard for the 2026-07-01 unification that replaced the per-surface ad-hoc classifiers.
//
// Also proves risk classification is input-SIZE independent: a risky token buried past the
// 1800-char display-preview truncation point must still be classified (the pre-fix bug
// computed risk over the truncated preview).

function pick(mod, name) {
  if (mod[name] !== undefined) return mod[name];
  if (mod.default && mod.default[name] !== undefined) return mod.default[name];
  return undefined;
}

async function load() {
  const toolRisk = await import('../dist/policy/toolRisk.js');
  const codexHooks = await import('../dist/codex/hooks.js');
  const geminiHooks = await import('../dist/gemini/hooks.js');
  return {
    computeToolRisk: pick(toolRisk, 'computeToolRisk'),
    normalizeCodexHookEvent: pick(codexHooks, 'normalizeCodexHookEvent'),
    normalizeGeminiHookEvent: pick(geminiHooks, 'normalizeGeminiHookEvent'),
  };
}

function claudeRisk(computeToolRisk, command) {
  return computeToolRisk('Bash', JSON.stringify({ command }));
}

function codexRisk(normalizeCodexHookEvent, command, extraInput = {}) {
  return normalizeCodexHookEvent({
    hook_event_name: 'PreToolUse',
    tool_name: 'shell',
    tool_input: { ...extraInput, command },
    session_id: 'sess-1',
    turn_id: 'turn-1',
    tool_use_id: 'use-1',
    cwd: process.cwd(),
  }).risk;
}

function geminiRisk(normalizeGeminiHookEvent, command) {
  return normalizeGeminiHookEvent({
    hook_event_name: 'BeforeTool',
    tool_name: 'run_shell_command',
    tool_input: { command },
    session_id: 'sess-1',
    cwd: process.cwd(),
  }).risk;
}

// Single-signal corpus with the expected ruleset level. (Multi-signal inputs can rank
// higher on surfaces that embed extra metadata in the searched content - highest-wins is
// the fail-safe direction - so the parity corpus stays single-signal.)
const CORPUS = [
  ['git push origin main', 'high'],
  ['npm publish --access public', 'high'],
  ['drop table users;', 'high'],
  ['sudo systemctl restart nginx', 'high'],
  ['rm -rf / --no-preserve-root', 'critical'],
  ['ls -la', 'low'],
  ['echo hello world', 'low'],
];

test('same command classifies identically on Claude, Codex, and Gemini surfaces', async () => {
  const { computeToolRisk, normalizeCodexHookEvent, normalizeGeminiHookEvent } = await load();
  assert.ok(computeToolRisk && normalizeCodexHookEvent && normalizeGeminiHookEvent, 'modules loaded');

  delete process.env.ORBITER_HOOK_POLICY;

  for (const [command, expected] of CORPUS) {
    const claude = claudeRisk(computeToolRisk, command);
    const codex = codexRisk(normalizeCodexHookEvent, command);
    const gemini = geminiRisk(normalizeGeminiHookEvent, command);
    assert.equal(claude, expected, `claude risk for: ${command}`);
    assert.equal(codex, expected, `codex risk for: ${command}`);
    assert.equal(gemini, expected, `gemini risk for: ${command}`);
  }
});

test('risk does not depend on input size (token past the preview truncation still counts)', async () => {
  const { normalizeCodexHookEvent } = await load();
  delete process.env.ORBITER_HOOK_POLICY;

  // JSON.stringify preserves insertion order, so a large leading arg pushes `command`
  // beyond the 1800-char display preview. Classification must still see it.
  const padded = codexRisk(normalizeCodexHookEvent, 'rm -rf / --no-preserve-root', {
    aaa_padding: 'x'.repeat(5000),
  });
  assert.equal(padded, 'critical');

  const paddedBenign = codexRisk(normalizeCodexHookEvent, 'ls -la', {
    aaa_padding: 'x'.repeat(5000),
  });
  assert.equal(paddedBenign, 'low');
});

test('claude surface extracts the command for action-targeted rules like a Codex action', async () => {
  const { computeToolRisk } = await load();
  delete process.env.ORBITER_HOOK_POLICY;

  // deploy-prod is an action-targeted rule; it must fire when the command carries the
  // deploy-to-protected-branch signal even though the tool NAME is just "Bash".
  assert.equal(computeToolRisk('Bash', JSON.stringify({ command: 'deploy the service to prod now' })), 'high');
});

test('ORBITER_HOOK_POLICY=legacy restores the pre-unification Claude heuristic', async () => {
  const { computeToolRisk } = await load();
  process.env.ORBITER_HOOK_POLICY = 'legacy';
  try {
    // Legacy quirk kept for rollback: bare "wipe" substring is critical.
    assert.equal(computeToolRisk('Bash', JSON.stringify({ command: 'wipe the scratch dir' })), 'critical');
    // Legacy maps any bash call to at least medium.
    assert.equal(computeToolRisk('Bash', JSON.stringify({ command: 'echo hello' })), 'medium');
  } finally {
    delete process.env.ORBITER_HOOK_POLICY;
  }
});
