const test = require('node:test');
const assert = require('node:assert/strict');

// Prove the richer policy-as-data ruleset v2 reproduces the antigravity classifier
// (mcp/src/antigravity/risk.ts -> evaluateAntigravityRisk) on a representative corpus.
// The contract is LEVEL-equivalence: evaluateRulesetV2(...).level must equal
// evaluateAntigravityRisk(...).level for every case. This is the prerequisite for wiring
// the antigravity adapter to interpret the ruleset behind ORBITER_HOOK_POLICY=data.
//
// As with the v1 corpus, both classifiers use highest-matched-risk-wins, so they agree on
// level. Flag/reason *text* is descriptive (not the gate contract); a few key flags are
// spot-checked below to confirm the structured output survives the data round-trip.

function pick(mod, name) {
  if (mod[name] !== undefined) return mod[name];
  if (mod.default && mod.default[name] !== undefined) return mod.default[name];
  return undefined;
}

async function load() {
  const v2 = await import('../dist/policy/rulesetV2.js');
  const ag = await import('../dist/antigravity/risk.js');
  return {
    evaluateRulesetV2: pick(v2, 'evaluateRulesetV2'),
    DEFAULT_ANTIGRAVITY_RULESET_V2: pick(v2, 'DEFAULT_ANTIGRAVITY_RULESET_V2'),
    evaluateAntigravityRisk: pick(ag, 'evaluateAntigravityRisk'),
  };
}

// [toolName, args, workspacePaths, expectedLevel]
// NOTE: the legacy sensitive-path regexes are deliberately precise - `\.env(?:\.|$)` matches
// `.env.production` / a trailing `.env`, but NOT a bare `.env` mid-string. The corpus uses
// paths that genuinely trip the patterns (.env.production, .pem, .ssh/id_rsa) so the
// sensitive/critical tiers are exercised faithfully against what the legacy classifier does.
const CORPUS = [
  // passive, workspace-scoped
  ['view_file', { TargetFile: '/proj/src/a.ts' }, ['/proj'], 'low'],
  ['ask_question', {}, [], 'low'],
  ['list_dir', { DirectoryPath: '/proj/src' }, ['/proj'], 'low'],
  // terminal (run_command is terminal + mutating)
  ['run_command', { CommandLine: 'ls -la' }, [], 'medium'],
  ['run_command', { CommandLine: 'rm -rf /' }, [], 'critical'],
  ['run_command', { CommandLine: 'git reset --hard HEAD~3' }, [], 'critical'],
  ['run_command', { CommandLine: 'npm publish' }, [], 'high'],
  ['run_command', { CommandLine: 'git push origin main' }, [], 'high'],
  ['run_command', { CommandLine: 'sudo reboot' }, [], 'high'],
  ['run_command', { CommandLine: 'psql -c "DROP TABLE users"' }, [], 'high'],
  // mutating file tools + path sensitivity
  ['write_to_file', { TargetFile: '/proj/secrets/server.pem' }, ['/proj'], 'critical'],
  ['write_to_file', { TargetFile: '/proj/.env.production' }, ['/proj'], 'critical'],
  ['view_file', { AbsolutePath: '/home/user/.ssh/id_rsa' }, ['/home/user'], 'critical'],
  ['write_to_file', { TargetFile: '/proj/package.json' }, ['/proj'], 'medium'],
  ['write_to_file', { TargetFile: '/proj/src/util.ts' }, ['/proj'], 'medium'],
  ['generate_image', {}, [], 'medium'],
  // read-only & agent-coordination tools classify low (ORB-33)
  ['read_file', { Path: '/proj/src/a.ts' }, ['/proj'], 'low'],
  ['view_file', { AbsolutePath: '/proj/docs/shipping/release_manifest.json' }, ['/proj'], 'low'],
  ['view_file', { AbsolutePath: '/proj/package.json' }, ['/proj'], 'low'],
  ['view_file_outline', { AbsolutePath: '/proj/src/a.ts' }, ['/proj'], 'low'],
  ['view_code_item', { File: '/proj/src/a.ts' }, ['/proj'], 'low'],
  ['find_by_name', { SearchDirectory: '/proj/src', Pattern: '*.sql' }, ['/proj'], 'low'],
  ['grep_search', { Query: 'DROP TABLE users', SearchPath: '/proj/src' }, ['/proj'], 'low'],
  ['send_message', { Recipient: 'subagent-1', Message: 'Verify rm -rf / guard' }, [], 'low'],
  ['manage_subagents', { Action: 'list' }, [], 'low'],
  ['update_focus', { focus: 'Auditing migration SQL' }, [], 'low'],
  ['update_steps', { steps: [{ title: 'Run tests', status: 'in_progress' }] }, [], 'low'],
  // tool-name-aware high-risk surfaces
  ['browser_navigate', { url: 'https://example.com' }, [], 'high'],
  ['mcp_call_tool', {}, [], 'high'],
  ['schedule', {}, [], 'high'],
  ['ask_permission', {}, [], 'high'],
  ['invoke_subagent', {}, [], 'high'],
  ['define_subagent', {}, [], 'high'],
  // manage_task: gated by Action
  ['manage_task', { Action: 'kill' }, [], 'high'],
  ['manage_task', { Action: 'send_input' }, [], 'high'],
  ['manage_task', { Action: 'list' }, [], 'low'],
  ['manage_task', { Action: 'status' }, [], 'low'],
  // network reads
  ['search_web', { query: 'x' }, [], 'medium'],
  ['read_url_content', { Url: 'https://example.com' }, [], 'medium'],
  // workspace-boundary escalation (target outside the declared workspace)
  ['run_command', { CommandLine: 'cat config', Cwd: '/etc' }, ['/proj'], 'high'],
];

test('legacy antigravity classifier matches the expected corpus', async () => {
  const { evaluateAntigravityRisk } = await load();
  for (const [tool, args, ws, expected] of CORPUS) {
    const got = evaluateAntigravityRisk(tool, args, ws).level;
    assert.equal(got, expected, `legacy ${tool} ${JSON.stringify(args)} -> ${got} (want ${expected})`);
  }
});

test('ruleset v2 reproduces the legacy classifier level across the corpus', async () => {
  const { evaluateRulesetV2, DEFAULT_ANTIGRAVITY_RULESET_V2, evaluateAntigravityRisk } = await load();
  for (const [tool, args, ws, expected] of CORPUS) {
    const viaData = evaluateRulesetV2(DEFAULT_ANTIGRAVITY_RULESET_V2, {
      toolName: tool,
      args,
      workspacePaths: ws,
    }).level;
    const viaLegacy = evaluateAntigravityRisk(tool, args, ws).level;
    assert.equal(viaData, viaLegacy, `v2!=legacy for ${tool} ${JSON.stringify(args)}`);
    assert.equal(viaData, expected, `v2!=expected for ${tool} ${JSON.stringify(args)}`);
  }
});

test('ruleset v2 returns structured reasons + flags (tool-name, path, workspace, passive)', async () => {
  const { evaluateRulesetV2, DEFAULT_ANTIGRAVITY_RULESET_V2 } = await load();
  const ev = (tool, args, ws) =>
    evaluateRulesetV2(DEFAULT_ANTIGRAVITY_RULESET_V2, { toolName: tool, args, workspacePaths: ws || [] });

  // structured shape
  const r = ev('run_command', { CommandLine: 'ls' });
  assert.ok(Array.isArray(r.reasons) && Array.isArray(r.flags));
  assert.ok(r.reasons.length > 0);

  // key flags survive the data round-trip
  assert.ok(ev('run_command', { CommandLine: 'rm -rf /' }).flags.includes('critical_command'));
  assert.ok(ev('browser_open', {}).flags.includes('browser_automation'));
  assert.ok(ev('mcp_x', {}).flags.includes('mcp_tool'));
  assert.ok(ev('manage_task', { Action: 'kill' }).flags.includes('task_control'));
  assert.ok(ev('manage_task', { Action: 'list' }).flags.includes('passive'));
  assert.ok(!ev('manage_task', { Action: 'list' }).flags.includes('mutating_tool'));
  assert.ok(!ev('manage_task', { Action: 'list' }).flags.includes('task_control'));
  assert.ok(ev('write_to_file', { TargetFile: '/proj/secrets/server.pem' }, ['/proj']).flags.includes('sensitive_path'));
  assert.ok(ev('run_command', { CommandLine: 'cat x', Cwd: '/etc' }, ['/proj']).flags.includes('outside_workspace'));
  assert.ok(ev('ask_question', {}).flags.includes('passive'));

  // {tool} interpolation in the mutating reason
  const mut = ev('write_to_file', { TargetFile: '/proj/src/a.ts' }, ['/proj']);
  assert.ok(mut.reasons.some((x) => x.includes('write_to_file')));
});

test('ruleset v2 is serializable policy-as-data (regex sources are strings)', async () => {
  const { DEFAULT_ANTIGRAVITY_RULESET_V2 } = await load();
  assert.equal(typeof DEFAULT_ANTIGRAVITY_RULESET_V2.version, 'string');
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(DEFAULT_ANTIGRAVITY_RULESET_V2)));
  for (const rule of DEFAULT_ANTIGRAVITY_RULESET_V2.rules) {
    if (rule.regex) for (const r of rule.regex) assert.equal(typeof r, 'string');
  }
});
