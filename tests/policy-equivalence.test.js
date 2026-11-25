const test = require('node:test');
const assert = require('node:assert/strict');

// Prove the policy-as-data ruleset reproduces the existing hardcoded classifier
// (mcp/src/codex/risk.ts -> evaluateCodexRisk) on single-signal inputs. This is the
// prerequisite for safely wiring the adapters to interpret the ruleset: behavior must
// match before the switch.
//
// NOTE ON SEMANTICS: the legacy classifier returns on the FIRST match in a priority
// order; the ruleset uses HIGHEST-matched-risk-wins. They are therefore equivalent on
// inputs that carry one signal, and the ruleset is intentionally *stricter* on
// multi-signal inputs (a safer default for a security gate). The corpus below is
// single-signal so the two agree exactly.

function pick(mod, name) {
  if (mod[name] !== undefined) return mod[name];
  if (mod.default && mod.default[name] !== undefined) return mod.default[name];
  return undefined;
}

async function load() {
  const r = await import('../dist/policy/ruleset.js');
  const c = await import('../dist/codex/risk.js');
  return {
    evaluateRuleset: pick(r, 'evaluateRuleset'),
    DEFAULT_RISK_RULESET: pick(r, 'DEFAULT_RISK_RULESET'),
    evaluateCodexRisk: pick(c, 'evaluateCodexRisk'),
  };
}

// [action, content, expected]
const CORPUS = [
  ['', 'rm -rf /', 'critical'],
  ['', 'rm -rf /tmp', 'high'],
  ['', 'sudo systemctl restart', 'high'],
  ['', 'DROP TABLE users', 'high'],
  ['', 'cat .env', 'high'],
  ['', 'git push origin', 'high'],
  ['', 'npm publish', 'high'],
  ['', 'edit package.json config', 'medium'],
  ['', 'rm notes.txt', 'medium'],
  ['', 'ls -la', 'low'],
  ['', 'echo hello world', 'low'],
  ['deploy to prod', '', 'high'],
];

test('legacy classifier matches the expected corpus', async () => {
  const { evaluateCodexRisk } = await load();
  for (const [action, content, expected] of CORPUS) {
    assert.equal(evaluateCodexRisk(action, content), expected, `legacy: ${JSON.stringify(content || action)}`);
  }
});

test('ruleset interpreter matches the legacy classifier on single-signal inputs', async () => {
  const { evaluateRuleset, DEFAULT_RISK_RULESET, evaluateCodexRisk } = await load();
  for (const [action, content, expected] of CORPUS) {
    const viaData = evaluateRuleset(DEFAULT_RISK_RULESET, { action, content });
    const viaLegacy = evaluateCodexRisk(action, content);
    assert.equal(viaData, viaLegacy, `ruleset!=legacy for ${JSON.stringify(content || action)}`);
    assert.equal(viaData, expected, `ruleset!=expected for ${JSON.stringify(content || action)}`);
  }
});

test('ruleset is intentionally stricter on multi-signal inputs (documented divergence)', async () => {
  const { evaluateRuleset, DEFAULT_RISK_RULESET, evaluateCodexRisk } = await load();
  // 'npm publish' (high) overlaps 'package.json' (medium). Legacy first-match order returns
  // medium; the ruleset escalates to high. Stricter is the safe direction for a gate.
  const input = { action: '', content: 'npm publish && touch package.json' };
  assert.equal(evaluateRuleset(DEFAULT_RISK_RULESET, input), 'high');
  assert.equal(evaluateCodexRisk(input.action, input.content), 'medium');
});
