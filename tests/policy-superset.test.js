const test = require('node:test');
const assert = require('node:assert/strict');

// SAFETY PROOF for flipping the default to policy-as-data (codex/gemini path).
//
// The contract for using the v1 ruleset as the DEFAULT gate is that it must be a *superset*
// of the legacy classifier: for every input, rank(ruleset) >= rank(legacy). Equal on
// single-signal inputs, stricter on multi-signal - never LESS strict (which would be a gate
// that misses what legacy caught). This corpus spans every legacy pattern category and the
// gaps that were closed when broadening the ruleset (format c:, .key, .sql, secrets.,
// credentials., production.yaml, git clean, remove-item -recurse).

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

const RANK = { low: 0, medium: 1, high: 2, critical: 3 };

// [action, content]
const CORPUS = [
  // critical (legacy criticalRiskPatterns)
  ['', 'rm -rf /'],
  ['', 'remove-item -recurse C:\\Users'],
  ['', 'format c:'],
  ['', 'del /f /q C:\\windows'],
  // high - destructive content
  ['', 'delete from users'],
  ['', 'drop table accounts'],
  ['', 'truncate table logs'],
  ['', 'export PRIVATE KEY material'],
  ['', 'aws_secret=abc'],
  ['', 'api_key=xyz'],
  ['', 'rm -rf node_modules'],
  ['', 'sudo apt update'],
  ['', 'format the disk'],
  ['', 'chmod -r 777 .'],
  ['', 'chown -r me .'],
  // high - sensitive files
  ['', 'cat .env'],
  ['', 'open cert.pem'],
  ['', 'read id_rsa.key'],
  ['', 'edit secrets.yaml'],
  ['', 'edit credentials.json'],
  ['', 'edit production.yaml'],
  // high - git/publish
  ['', 'git push origin main'],
  ['', 'git reset --hard'],
  ['', 'git clean -fd'],
  ['', 'npm publish'],
  // high - deploy action
  ['deploy to prod', ''],
  ['merge into main', ''],
  // medium - manifests
  ['', 'edit go.mod'],
  ['', 'edit package.json'],
  ['', 'edit cargo.toml'],
  ['', 'apply schema.sql'],
  ['', 'edit Dockerfile'],
  ['', 'run db migration'],
  ['', 'edit .github/workflows/ci.yml'],
  // medium - remove cmds
  ['', 'rm notes.txt'],
  ['', 'del file.txt'],
  ['', 'kill 1234'],
  // low
  ['', 'ls -la'],
  ['', 'echo hello world'],
  ['', 'cat README.md'],
];

test('ruleset is a superset of legacy: rank(ruleset) >= rank(legacy) for every input', async () => {
  const { evaluateRuleset, DEFAULT_RISK_RULESET, evaluateCodexRisk } = await load();
  for (const [action, content] of CORPUS) {
    const viaData = evaluateRuleset(DEFAULT_RISK_RULESET, { action, content });
    const viaLegacy = evaluateCodexRisk(action, content);
    assert.ok(
      RANK[viaData] >= RANK[viaLegacy],
      `UNSAFE: ruleset under-matched legacy for ${JSON.stringify(content || action)}: ruleset=${viaData} < legacy=${viaLegacy}`,
    );
  }
});

test('broadened ruleset closes the specific legacy-coverage gaps', async () => {
  const { evaluateRuleset, DEFAULT_RISK_RULESET } = await load();
  const ev = (content) => evaluateRuleset(DEFAULT_RISK_RULESET, { content });
  // these were genuinely missed by the old flat ruleset but caught (critical/high/medium) by legacy
  assert.equal(ev('format c:'), 'critical');
  assert.equal(ev('del /f C:\\windows'), 'critical');
  assert.equal(ev('read id_rsa.key'), 'high');
  assert.equal(ev('edit secrets.yaml'), 'high');
  assert.equal(ev('edit credentials.json'), 'high');
  assert.equal(ev('edit production.yaml'), 'high');
  assert.equal(ev('git clean -fd'), 'high');
  assert.equal(ev('apply schema.sql'), 'medium');
});
