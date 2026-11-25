const test = require('node:test');
const assert = require('node:assert/strict');

// dist modules may compile to ESM or CJS; dynamic import + a defensive picker handles both.
function pick(mod, name) {
  if (mod[name] !== undefined) return mod[name];
  if (mod.default && mod.default[name] !== undefined) return mod.default[name];
  return undefined;
}

async function loadRuleset() {
  const m = await import('../dist/policy/ruleset.js');
  return {
    evaluateRuleset: pick(m, 'evaluateRuleset'),
    DEFAULT_RISK_RULESET: pick(m, 'DEFAULT_RISK_RULESET'),
    maxRisk: pick(m, 'maxRisk'),
  };
}

async function loadMatrix() {
  const m = await import('../dist/policy/compatibilityMatrix.js');
  return {
    resolveMatrix: pick(m, 'resolveMatrix'),
    DEFAULT_COMPATIBILITY_MATRIX: pick(m, 'DEFAULT_COMPATIBILITY_MATRIX'),
  };
}

test('ruleset interpreter reproduces expected risk classifications', async () => {
  const { evaluateRuleset, DEFAULT_RISK_RULESET, maxRisk } = await loadRuleset();
  assert.equal(evaluateRuleset(DEFAULT_RISK_RULESET, { content: 'rm -rf /' }), 'critical');
  assert.equal(evaluateRuleset(DEFAULT_RISK_RULESET, { content: 'npm publish' }), 'high');
  assert.equal(evaluateRuleset(DEFAULT_RISK_RULESET, { content: 'DROP TABLE users' }), 'high');
  assert.equal(evaluateRuleset(DEFAULT_RISK_RULESET, { content: 'edit package.json' }), 'medium');
  assert.equal(evaluateRuleset(DEFAULT_RISK_RULESET, { content: 'ls -la' }), 'low');
  assert.equal(maxRisk('low', 'high'), 'high');
});

test('ruleset takes the highest matched risk (fail-safe stricter)', async () => {
  const { evaluateRuleset, DEFAULT_RISK_RULESET } = await loadRuleset();
  // medium signal (package.json) + high signal (npm publish) -> high
  assert.equal(evaluateRuleset(DEFAULT_RISK_RULESET, { content: 'npm publish && touch package.json' }), 'high');
});

test('ruleset is serializable policy-as-data', async () => {
  const { DEFAULT_RISK_RULESET } = await loadRuleset();
  assert.equal(typeof DEFAULT_RISK_RULESET.version, 'string');
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(DEFAULT_RISK_RULESET)));
});

test('compatibility matrix resolves known IDEs and a conservative fallback', async () => {
  const { resolveMatrix, DEFAULT_COMPATIBILITY_MATRIX } = await loadMatrix();
  const claude = resolveMatrix('claude', '2.1.0');
  assert.equal(claude.edge, 'http-hook');
  assert.equal(claude.failPolicy, 'fail-closed');

  const codex = resolveMatrix('codex', '1.0.0');
  assert.equal(codex.trust, 'hash-trust');

  const unknown = resolveMatrix('mystery-ide', '9.9.9');
  assert.equal(unknown.failPolicy, 'fail-closed'); // safe default for unseen versions
  assert.equal(unknown.edge, 'command-shim');

  assert.equal(typeof DEFAULT_COMPATIBILITY_MATRIX.version, 'string');
});
