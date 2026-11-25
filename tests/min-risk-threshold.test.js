/**
 * B-118 - unified approval risk threshold (ORBITER_MIN_RISK).
 *
 * The critical property under test is BACKWARD COMPATIBILITY: with ORBITER_MIN_RISK
 * unset, every surface must behave exactly as it did before this change, because each
 * passes its own historical default (Claude 'low', Codex/Gemini 'high').
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  meetsMinRisk,
  resolveMinRisk,
  parseRiskLevel,
  riskRank,
} = require('../dist/policy/ruleset.js');

test('parseRiskLevel accepts valid levels and rejects junk', () => {
  assert.equal(parseRiskLevel('low'), 'low');
  assert.equal(parseRiskLevel('HIGH'), 'high');
  assert.equal(parseRiskLevel('  Critical '), 'critical');
  assert.equal(parseRiskLevel('banana'), undefined);
  assert.equal(parseRiskLevel(''), undefined);
  assert.equal(parseRiskLevel(undefined), undefined);
});

test('riskRank orders levels correctly', () => {
  assert.ok(riskRank('low') < riskRank('medium'));
  assert.ok(riskRank('medium') < riskRank('high'));
  assert.ok(riskRank('high') < riskRank('critical'));
});

test('resolveMinRisk falls back to the per-surface default when unset', () => {
  assert.equal(resolveMinRisk('low', {}), 'low');
  assert.equal(resolveMinRisk('high', {}), 'high');
});

test('resolveMinRisk falls back on an UNPARSEABLE value rather than loosening the gate', () => {
  // A typo must never silently mute a surface.
  assert.equal(resolveMinRisk('high', { ORBITER_MIN_RISK: 'hgih' }), 'high');
  assert.equal(resolveMinRisk('low', { ORBITER_MIN_RISK: '' }), 'low');
});

test('resolveMinRisk honours a valid override', () => {
  assert.equal(resolveMinRisk('low', { ORBITER_MIN_RISK: 'high' }), 'high');
  assert.equal(resolveMinRisk('high', { ORBITER_MIN_RISK: 'low' }), 'low');
});

test('BACKWARD COMPAT: Claude default (low) escalates every level, as before B-118', () => {
  for (const level of ['low', 'medium', 'high', 'critical']) {
    assert.equal(meetsMinRisk(level, 'low'), true, `${level} should escalate at min=low`);
  }
});

test('BACKWARD COMPAT: Codex/Gemini default (high) escalates only high+critical', () => {
  assert.equal(meetsMinRisk('low', 'high'), false);
  assert.equal(meetsMinRisk('medium', 'high'), false);
  assert.equal(meetsMinRisk('high', 'high'), true);
  assert.equal(meetsMinRisk('critical', 'high'), true);
});

test('FAIL-SAFE: critical always escalates regardless of threshold', () => {
  // A misconfigured threshold must never mute a destructive action.
  assert.equal(meetsMinRisk('critical', 'critical'), true);
  assert.equal(meetsMinRisk('critical', 'high'), true);
  assert.equal(meetsMinRisk('critical', 'low'), true);
});

test('min=critical mutes low/medium/high but not critical', () => {
  assert.equal(meetsMinRisk('low', 'critical'), false);
  assert.equal(meetsMinRisk('medium', 'critical'), false);
  assert.equal(meetsMinRisk('high', 'critical'), false);
  assert.equal(meetsMinRisk('critical', 'critical'), true);
});

test('the founder goal: ORBITER_MIN_RISK=high makes Claude behave like Codex', () => {
  const claudeMin = resolveMinRisk('low', { ORBITER_MIN_RISK: 'high' });
  const codexMin = resolveMinRisk('high', {});
  assert.equal(claudeMin, codexMin);
  for (const level of ['low', 'medium', 'high', 'critical']) {
    assert.equal(
      meetsMinRisk(level, claudeMin),
      meetsMinRisk(level, codexMin),
      `${level} should route identically on both surfaces`,
    );
  }
});
