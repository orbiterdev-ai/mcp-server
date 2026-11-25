const test = require('node:test');
const assert = require('node:assert/strict');

// Verifies the policy-as-data wiring of ruleset v2 into the live antigravity hook path
// (mcp/src/antigravity/risk.ts -> evaluateAntigravityRiskWithPolicy). The DEFAULT is now
// ruleset v2 (level-parity with the legacy classifier is proven by policy-equivalence-v2).
// ORBITER_HOOK_POLICY=legacy (or code) is the rollback escape hatch to the hardcoded classifier.

function pick(mod, name) {
  if (mod[name] !== undefined) return mod[name];
  if (mod.default && mod.default[name] !== undefined) return mod.default[name];
  return undefined;
}

async function load() {
  const r = await import('../dist/antigravity/risk.js');
  return {
    withPolicy: pick(r, 'evaluateAntigravityRiskWithPolicy'),
    legacy: pick(r, 'evaluateAntigravityRisk'),
  };
}

// A path that is BOTH sensitive (.pem under secrets/) and config-matching (package.json).
// Legacy uses an else-if (sensitive wins, no config flag); ruleset v2 fires both rules. The
// presence/absence of 'configuration_path' therefore distinguishes which path actually ran,
// even though both report the same critical LEVEL.
const OVERLAP = ['write_to_file', { TargetFile: '/proj/secrets/server.pem', Note: 'package.json' }, ['/proj']];

// [toolName, args, workspacePaths]
const CASES = [
  ['view_file', { TargetFile: '/proj/a.ts' }, ['/proj']],
  ['run_command', { CommandLine: 'rm -rf /' }, []],
  ['run_command', { CommandLine: 'npm publish' }, []],
  ['browser_open', { url: 'https://x' }, []],
  ['manage_task', { Action: 'kill' }, []],
  ['run_command', { CommandLine: 'cat config', Cwd: '/etc' }, ['/proj']],
];

test('defaults to ruleset v2 when the flag is unset (proven via the overlap flag)', async () => {
  const { withPolicy, legacy } = await load();
  delete process.env.ORBITER_HOOK_POLICY;
  // level parity always holds (v2 is level-equivalent to legacy)
  for (const [tool, args, ws] of CASES) {
    assert.equal(withPolicy(tool, args, ws).level, legacy(tool, args, ws).level, `level parity: ${tool}`);
  }
  // routing proof: the default path emits v2's extra configuration_path flag on the overlap
  const policy = withPolicy(...OVERLAP);
  assert.equal(policy.level, 'critical');
  assert.ok(policy.flags.includes('configuration_path'), 'default should route to ruleset v2 (both flags)');
  assert.ok(policy.flags.includes('sensitive_path'));
});

test('ORBITER_HOOK_POLICY=legacy (and code) falls back to the hardcoded classifier', async () => {
  const { withPolicy, legacy } = await load();
  for (const mode of ['legacy', 'code']) {
    process.env.ORBITER_HOOK_POLICY = mode;
    try {
      const policy = withPolicy(...OVERLAP);
      const direct = legacy(...OVERLAP);
      assert.deepEqual(policy, direct, `legacy mode (${mode}) should match the hardcoded classifier exactly`);
      // legacy's else-if means the config flag is absent even though it's critical
      assert.equal(policy.flags.includes('configuration_path'), false);
    } finally {
      delete process.env.ORBITER_HOOK_POLICY;
    }
  }
});

test('explicit ORBITER_HOOK_POLICY=data uses ruleset v2 with structured output', async () => {
  const { withPolicy } = await load();
  process.env.ORBITER_HOOK_POLICY = 'data';
  try {
    for (const [tool, args, ws] of CASES) {
      const policy = withPolicy(tool, args, ws);
      assert.ok(Array.isArray(policy.reasons) && Array.isArray(policy.flags), `structured: ${tool}`);
    }
    assert.equal(withPolicy('run_command', { CommandLine: 'rm -rf /' }, []).level, 'critical');
    assert.equal(withPolicy('browser_open', {}, []).level, 'high');
    assert.equal(withPolicy('view_file', { TargetFile: '/proj/a.ts' }, ['/proj']).level, 'low');
  } finally {
    delete process.env.ORBITER_HOOK_POLICY;
  }
});

test('an unrecognized flag value resolves to the data default (not legacy)', async () => {
  const { withPolicy } = await load();
  process.env.ORBITER_HOOK_POLICY = 'nonsense';
  try {
    assert.ok(withPolicy(...OVERLAP).flags.includes('configuration_path'), 'unknown flag should default to ruleset v2');
  } finally {
    delete process.env.ORBITER_HOOK_POLICY;
  }
});
