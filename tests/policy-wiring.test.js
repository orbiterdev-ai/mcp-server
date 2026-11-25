const test = require('node:test');
const assert = require('node:assert/strict');

// Verifies the policy-as-data wiring in the live codex/gemini hook path
// (mcp/src/codex/risk.ts -> evaluateCodexRiskWithPolicy). The DEFAULT is now the data
// ruleset (a proven superset of legacy; see policy-superset.test.js). Setting
// ORBITER_HOOK_POLICY=legacy (or code) is the rollback escape hatch to the hardcoded classifier.

function pick(mod, name) {
  if (mod[name] !== undefined) return mod[name];
  if (mod.default && mod.default[name] !== undefined) return mod.default[name];
  return undefined;
}

async function load() {
  const r = await import('../dist/codex/risk.js');
  const p = await import('../dist/policy/ruleset.js');
  return {
    withPolicy: pick(r, 'evaluateCodexRiskWithPolicy'),
    legacy: pick(r, 'evaluateCodexRisk'),
    evaluateRuleset: pick(p, 'evaluateRuleset'),
    DEFAULT_RISK_RULESET: pick(p, 'DEFAULT_RISK_RULESET'),
  };
}

test('defaults to the data ruleset when the flag is unset', async () => {
  const { withPolicy, evaluateRuleset, DEFAULT_RISK_RULESET } = await load();
  delete process.env.ORBITER_HOOK_POLICY;
  for (const c of ['rm -rf /', 'npm publish && touch package.json', 'ls -la', 'edit package.json', 'sudo reboot']) {
    assert.equal(withPolicy('', c), evaluateRuleset(DEFAULT_RISK_RULESET, { action: '', content: c }), `default should be data for: ${c}`);
  }
  // multi-signal: the data ruleset is stricter (high) than the legacy classifier (medium)
  assert.equal(withPolicy('', 'npm publish && touch package.json'), 'high');
});

test('ORBITER_HOOK_POLICY=legacy falls back to the hardcoded classifier', async () => {
  const { withPolicy, legacy } = await load();
  process.env.ORBITER_HOOK_POLICY = 'legacy';
  try {
    for (const c of ['rm -rf /', 'npm publish && touch package.json', 'ls -la', 'edit package.json', 'sudo reboot']) {
      assert.equal(withPolicy('', c), legacy('', c), `legacy mode mismatch for: ${c}`);
    }
    // 'code' is an accepted alias for the legacy escape hatch
    process.env.ORBITER_HOOK_POLICY = 'code';
    assert.equal(withPolicy('', 'npm publish && touch package.json'), legacy('', 'npm publish && touch package.json'));
  } finally {
    delete process.env.ORBITER_HOOK_POLICY;
  }
});

test('explicit ORBITER_HOOK_POLICY=data uses the data ruleset', async () => {
  const { withPolicy } = await load();
  process.env.ORBITER_HOOK_POLICY = 'data';
  try {
    assert.equal(withPolicy('', 'npm publish && touch package.json'), 'high');
    assert.equal(withPolicy('', 'rm -rf /'), 'critical');
    assert.equal(withPolicy('', 'ls -la'), 'low');
  } finally {
    delete process.env.ORBITER_HOOK_POLICY;
  }
});

test('an unrecognized flag value resolves to the data default (not legacy)', async () => {
  const { withPolicy, evaluateRuleset, DEFAULT_RISK_RULESET } = await load();
  process.env.ORBITER_HOOK_POLICY = 'nonsense';
  try {
    const c = 'npm publish && touch package.json';
    assert.equal(withPolicy('', c), evaluateRuleset(DEFAULT_RISK_RULESET, { action: '', content: c }));
    assert.equal(withPolicy('', c), 'high');
  } finally {
    delete process.env.ORBITER_HOOK_POLICY;
  }
});
