/**
 * Policy-as-data ruleset (hosted-hooks paper, Tier-1.5). A versioned, serializable risk
 * policy that a classifier *interprets* - so updating hook behavior becomes a published,
 * signed bundle, not new client code. v1 deliberately mirrors the existing per-adapter
 * classifiers' intent (deny-patterns, contains-lists, regexes, thresholds) as DATA.
 *
 * This module is additive and self-contained: it is NOT yet wired into the live adapters
 * (codex/risk.ts, antigravity/risk.ts). Wiring the adapters to interpret a pulled ruleset
 * is a later, gated step. Kept dependency-free so it can also run server-side.
 */

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface RiskRule {
  /** Stable id for audit / decision logs. */
  id: string;
  /** Risk assigned when this rule matches. */
  risk: RiskLevel;
  /** Case-insensitive substrings matched against the target. */
  contains?: string[];
  /** Regex sources (matched case-insensitively) against the target. */
  regex?: string[];
  /** Field to match: the tool action or the command/content. Default 'content'. */
  target?: 'action' | 'content';
  /** Optional human note. */
  note?: string;
}

export interface RiskRuleset {
  /** Bundle version for ETag / staged rollout (signed, versioned ruleset). */
  version: string;
  /** Default risk when no rule matches. */
  default: RiskLevel;
  /** Rules; the HIGHEST matched risk wins (fail-safe toward stricter). */
  rules: RiskRule[];
}

const ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return ORDER[a] >= ORDER[b] ? a : b;
}

/** Numeric rank of a risk level. Exported so adapters compare consistently. */
export function riskRank(level: RiskLevel): number {
  return ORDER[level];
}

/** Parse an arbitrary string into a RiskLevel, or undefined if it is not one. */
export function parseRiskLevel(value: string | undefined | null): RiskLevel | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized in ORDER ? (normalized as RiskLevel) : undefined;
}

/**
 * B-118: the single approval-routing threshold shared by every IDE surface.
 *
 * `ORBITER_MIN_RISK` (low|medium|high|critical) is the minimum risk that is escalated to
 * the phone. Anything below it is allowed locally and never leaves the machine.
 *
 * Each surface passes its OWN historical default so that setting nothing preserves
 * today's behavior exactly:
 *   - Claude Code   -> 'low'   (no gate historically: everything was escalated)
 *   - Codex/Gemini  -> 'high'  (hardcoded isHighCodexRisk: high + critical only)
 * An unset or unparseable value falls back to that per-surface default rather than
 * silently loosening or tightening the gate.
 */
export function resolveMinRisk(fallback: RiskLevel, env: NodeJS.ProcessEnv = process.env): RiskLevel {
  return parseRiskLevel(env.ORBITER_MIN_RISK) ?? fallback;
}

/**
 * True when `level` is at or above `minimum`, i.e. the action must be escalated for
 * approval. Fail-safe direction: 'critical' always escalates regardless of threshold, so
 * a misconfigured value can never mute a destructive action.
 */
export function meetsMinRisk(level: RiskLevel, minimum: RiskLevel): boolean {
  if (level === 'critical') return true;
  return ORDER[level] >= ORDER[minimum];
}

export interface RiskInput {
  action?: string;
  content?: string;
}

function safeTest(source: string, value: string): boolean {
  try {
    return new RegExp(source, 'i').test(value);
  } catch {
    return false;
  }
}

/** Interpret the ruleset over an input. Highest matched risk wins; the default otherwise. */
export function evaluateRuleset(ruleset: RiskRuleset, input: RiskInput): RiskLevel {
  const actionRaw = input.action ?? '';
  const contentRaw = input.content ?? '';
  const actionLower = actionRaw.toLowerCase();
  const contentLower = contentRaw.toLowerCase();

  let result: RiskLevel = ruleset.default;
  for (const rule of ruleset.rules) {
    const target = rule.target ?? 'content';
    const hayLower = target === 'action' ? actionLower : contentLower;
    const hayRaw = target === 'action' ? actionRaw : contentRaw;
    let matched = false;
    if (rule.contains?.some((s) => hayLower.includes(s.toLowerCase()))) matched = true;
    if (!matched && rule.regex?.some((r) => safeTest(r, hayRaw))) matched = true;
    if (matched) result = maxRisk(result, rule.risk);
  }
  return result;
}

/**
 * Critical drive/root-destruction patterns, mirroring the legacy codex `criticalRiskPatterns`
 * exactly. Authored as RegExp literals and serialized to `.source` so the ruleset stays plain
 * JSON-data while avoiding hand-escaping mistakes (same technique as rulesetV2).
 */
const CRITICAL_DESTRUCTION_PATTERNS = [
  /\brm\s+-rf\s+(?:\/(?:\s|["']|$)|\/\*|[a-z]:\\)/i,
  /\bremove-item\b[\s\S]*\b-recurse\b[\s\S]*(?:[a-z]:\\|\/(?:\s|["']|$))/i,
  /\bformat\s+[a-z]:/i,
  /\bdel\s+\/[a-z]*[fsq][a-z]*\s+[a-z]:\\/i,
];

const ruleSources = (patterns: RegExp[]): string[] => patterns.map((p) => p.source);

/**
 * Default v1 ruleset - a **superset** of the legacy codex/gemini classifier's intent expressed
 * as data. "Superset" is the safety contract for using this as the default gate: for every
 * input, the interpreted risk is >= the legacy classifier's (never less strict). Proven by
 * `policy-superset.test.js`. Highest-matched-risk wins.
 */
export const DEFAULT_RISK_RULESET: RiskRuleset = {
  version: '2026-06-25.1',
  default: 'low',
  rules: [
    {
      id: 'critical-destruction',
      risk: 'critical',
      regex: ruleSources(CRITICAL_DESTRUCTION_PATTERNS),
      note: 'recursive/forced delete or drive format targeting a root/drive path (legacy critical set)',
    },
    {
      id: 'deploy-prod',
      risk: 'high',
      target: 'action',
      // Intentionally substring-style (no \b) and newline-agnostic ([\s\S]* not .*): mirrors the
      // legacy `includes('deploy') && includes(branch)` heuristic so the ruleset never
      // under-matches legacy (over-matching a protected branch is the fail-safe direction).
      regex: ['(merge|deploy)[\\s\\S]*(main|master|prod)', '(main|master|prod)[\\s\\S]*(merge|deploy)'],
      note: 'merge/deploy to a protected branch',
    },
    { id: 'destructive-db', risk: 'high', contains: ['drop table', 'delete from', 'truncate table'] },
    {
      id: 'secrets',
      risk: 'high',
      contains: ['private key', 'aws_secret', 'api_key', '.env', '.pem', '.key', 'secrets.', 'credentials.', 'production.yaml'],
    },
    { id: 'destructive-shell', risk: 'high', contains: ['rm -rf', 'sudo', 'format', 'chmod -r 777', 'chown -r'] },
    {
      id: 'publish-push',
      risk: 'high',
      regex: ['\\bgit\\s+push\\b', '\\bgit\\s+reset\\b', '\\bgit\\s+clean\\b', '\\bnpm\\s+publish\\b'],
    },
    {
      id: 'pkg-manifests',
      risk: 'medium',
      contains: ['go.mod', 'package.json', 'cargo.toml', '.sql', 'dockerfile', 'migration', '.github/workflows'],
    },
    { id: 'remove-cmds', risk: 'medium', regex: ['\\b(rm|del|remove-item|erase|kill|stop-process)\\b'] },
  ],
};

/**
 * Hook risk-policy mode. **Default is now ruleset v2** on every surface (the Tier-1.5
 * convergence): the generic v2 ruleset with per-host extract configs interprets risk for
 * Claude Code, Codex, and Gemini; Antigravity keeps its richer host-specific v2 ruleset.
 *
 * Escape hatches, newest to oldest:
 *   `ORBITER_HOOK_POLICY=v1`     → the flat v1 string ruleset (2026-06-25 behavior)
 *   `ORBITER_HOOK_POLICY=legacy` (or `code`) → the hardcoded per-adapter classifiers
 * Any other value (including unset, `data`, `v2`) resolves to 'v2'.
 */
export function hookPolicyMode(): 'v2' | 'v1' | 'legacy' {
  const v = (process.env.ORBITER_HOOK_POLICY ?? '').toLowerCase();
  if (v === 'legacy' || v === 'code') return 'legacy';
  if (v === 'v1' || v === 'data-v1') return 'v1';
  return 'v2';
}
