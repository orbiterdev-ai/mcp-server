const test = require('node:test');
const assert = require('node:assert/strict');

// Tier-1.5 convergence proof: the generic ruleset v2 (one rule table + per-host extract
// configs) is the default classifier for the former v1 surfaces (Claude/Codex/Gemini).
//   1. For real tool calls, the v2 level is >= the v1 level (never less strict).
//   2. The same command classifies identically across all three host extract configs.
//   3. Per-host extract keys are honored (e.g. Codex `CommandLine`).
//   4. ORBITER_HOOK_POLICY=v1 still selects the flat v1 ruleset path.

function pick(mod, name) {
  if (mod[name] !== undefined) return mod[name];
  if (mod.default && mod.default[name] !== undefined) return mod.default[name];
  return undefined;
}

async function load() {
  const generic = await import('../dist/policy/genericRulesetV2.js');
  const v2 = await import('../dist/policy/rulesetV2.js');
  const v1 = await import('../dist/policy/ruleset.js');
  const risk = await import('../dist/codex/risk.js');
  return {
    genericRulesetV2For: pick(generic, 'genericRulesetV2For'),
    evaluateRulesetV2: pick(v2, 'evaluateRulesetV2'),
    evaluateRuleset: pick(v1, 'evaluateRuleset'),
    DEFAULT_RISK_RULESET: pick(v1, 'DEFAULT_RISK_RULESET'),
    hookPolicyMode: pick(v1, 'hookPolicyMode'),
    evaluateHostToolRiskWithPolicy: pick(risk, 'evaluateHostToolRiskWithPolicy'),
  };
}

const ORDER = { low: 0, medium: 1, high: 2, critical: 3 };

// (command, minimum expected level) - the v1 level for these inputs.
const COMMAND_CORPUS = [
  ['rm -rf / --no-preserve-root', 'critical'],
  ['git push origin main', 'high'],
  ['git reset --hard HEAD~1', 'high'],
  ['npm publish', 'high'],
  ['drop table users;', 'high'],
  ['delete from accounts where 1=1', 'high'],
  ['sudo apt-get install foo', 'high'],
  ['cat .env', 'high'],
  ['deploy the release to prod', 'high'],
  ['edit package.json scripts', 'medium'],
  ['kill 1234', 'medium'],
  ['ls -la', 'low'],
  ['echo hello world', 'low'],
];

test('generic v2 level >= v1 level over the command corpus, on every host', async () => {
  const { genericRulesetV2For, evaluateRulesetV2, evaluateRuleset, DEFAULT_RISK_RULESET } = await load();
  delete process.env.ORBITER_HOOK_POLICY;

  for (const [command, expected] of COMMAND_CORPUS) {
    const v1Level = evaluateRuleset(DEFAULT_RISK_RULESET, { action: `shell: ${command}`, content: JSON.stringify({ command }) });
    assert.equal(v1Level, expected, `v1 corpus pin for: ${command}`);

    for (const host of ['claude', 'codex', 'gemini']) {
      const v2 = evaluateRulesetV2(genericRulesetV2For(host), { toolName: 'shell', args: { command } });
      assert.ok(
        ORDER[v2.level] >= ORDER[v1Level],
        `${host} v2 (${v2.level}) must be >= v1 (${v1Level}) for: ${command}`,
      );
    }
  }
});

test('same command classifies identically across the three host extract configs', async () => {
  const { genericRulesetV2For, evaluateRulesetV2 } = await load();
  for (const [command] of COMMAND_CORPUS) {
    const levels = ['claude', 'codex', 'gemini'].map(
      (host) => evaluateRulesetV2(genericRulesetV2For(host), { toolName: 'shell', args: { command } }).level,
    );
    assert.equal(new Set(levels).size, 1, `host levels diverge for: ${command} -> ${levels.join(',')}`);
  }
});

test('per-host extract keys are honored (Codex CommandLine carries the command)', async () => {
  const { genericRulesetV2For, evaluateRulesetV2 } = await load();
  const viaCommandLine = evaluateRulesetV2(genericRulesetV2For('codex'), {
    toolName: 'run_command',
    args: { CommandLine: 'git push origin main' },
  });
  assert.equal(viaCommandLine.level, 'high');
  assert.ok(viaCommandLine.flags.includes('publish_push'));
});

test('structured reasons and flags surface for audit logs', async () => {
  const { genericRulesetV2For, evaluateRulesetV2 } = await load();
  const result = evaluateRulesetV2(genericRulesetV2For('claude'), {
    toolName: 'Bash',
    args: { command: 'sudo rm -rf /var/data && git push origin main' },
  });
  assert.equal(result.level, 'high');
  assert.ok(result.reasons.length >= 2, 'multiple matched rules accumulate reasons');
});

test('ORBITER_HOOK_POLICY=v1 selects the flat v1 ruleset path', async () => {
  const { hookPolicyMode, evaluateHostToolRiskWithPolicy } = await load();
  process.env.ORBITER_HOOK_POLICY = 'v1';
  try {
    assert.equal(hookPolicyMode(), 'v1');
    // v1's deploy-prod rule is action-targeted; with a benign action string the same
    // words in a non-command arg do NOT raise risk under v1...
    const v1Level = evaluateHostToolRiskWithPolicy('codex', 'shell', { note: 'deploy docs about prod' }, 'shell', JSON.stringify({ note: 'deploy docs about prod' }));
    assert.equal(v1Level, 'low');
  } finally {
    delete process.env.ORBITER_HOOK_POLICY;
  }
  // ...while default v2 is stricter (searchable field), the documented fail-safe direction.
  const { evaluateHostToolRiskWithPolicy: hostEval } = await load();
  const v2Level = hostEval('codex', 'shell', { note: 'deploy docs about prod' }, 'shell', JSON.stringify({ note: 'deploy docs about prod' }));
  assert.equal(v2Level, 'high');
});
