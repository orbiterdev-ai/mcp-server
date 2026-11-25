import type { CodexRiskLevel } from './types.js';
import { evaluateRuleset, DEFAULT_RISK_RULESET, hookPolicyMode } from '../policy/ruleset.js';
import { evaluateRulesetV2 } from '../policy/rulesetV2.js';
import { genericRulesetV2For, type GenericPolicyHost } from '../policy/genericRulesetV2.js';

const riskOrder: Record<CodexRiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const highRiskBranches = ['main', 'master', 'prod'];
const highRiskFiles = ['.env', '.key', '.pem', 'secrets.', 'credentials.', 'production.yaml'];
const mediumRiskFiles = ['go.mod', 'package.json', 'cargo.toml', '.sql', 'migration', 'dockerfile', '.github/workflows'];
const criticalRiskPatterns = [
  /\brm\s+-rf\s+(?:\/(?:\s|["']|$)|\/\*|[a-z]:\\)/i,
  /\bremove-item\b[\s\S]*\b-recurse\b[\s\S]*(?:[a-z]:\\|\/(?:\s|["']|$))/i,
  /\bformat\s+[a-z]:/i,
  /\bdel\s+\/[a-z]*[fsq][a-z]*\s+[a-z]:\\/i,
];
const highRiskContent = [
  'delete from',
  'drop table',
  'truncate table',
  'private key',
  'aws_secret',
  'api_key',
  'rm -rf',
  'sudo',
  'format',
  'chmod -r 777',
  'chown -r',
];

export function maxRisk(a: CodexRiskLevel, b: CodexRiskLevel): CodexRiskLevel {
  return riskOrder[a] >= riskOrder[b] ? a : b;
}

export function evaluateCodexRisk(action: string, content: string): CodexRiskLevel {
  const lowerAction = action.toLowerCase();
  const lowerContent = content.toLowerCase();

  if (criticalRiskPatterns.some((pattern) => pattern.test(content))) return 'critical';

  if ((lowerAction.includes('merge') || lowerAction.includes('deploy')) &&
    highRiskBranches.some((branch) => lowerAction.includes(branch))) {
    return 'high';
  }

  if (containsAny(lowerContent, highRiskContent)) return 'high';
  if (containsAny(lowerContent, highRiskFiles)) return 'high';
  if (containsAny(lowerContent, mediumRiskFiles)) return 'medium';

  if (/\b(rm|del|remove-item|erase|kill|stop-process)\b/i.test(content)) return 'medium';
  if (/\b(git\s+push|git\s+reset|git\s+clean|npm\s+publish)\b/i.test(content)) return 'high';
  return 'low';
}

export function isHighCodexRisk(risk: CodexRiskLevel): boolean {
  return risk === 'high' || risk === 'critical';
}

/**
 * String-based policy evaluation (v1 dialect). Retained for the `ORBITER_HOOK_POLICY=v1`
 * escape hatch and the equivalence/superset proof corpus; the live hook path is
 * `evaluateHostToolRiskWithPolicy` below. 'legacy' falls back to the hardcoded classifier.
 */
export function evaluateCodexRiskWithPolicy(action: string, content: string): CodexRiskLevel {
  if (hookPolicyMode() === 'legacy') {
    return evaluateCodexRisk(action, content);
  }
  return evaluateRuleset(DEFAULT_RISK_RULESET, { action, content }) as CodexRiskLevel;
}

/**
 * The converged host evaluator (Tier-1.5). **Default is ruleset v2**: one shared rule
 * table interpreted over the tool call itself (toolName + args) with per-host extract
 * configs - the same engine and input shape the Antigravity adapter already uses, so a
 * command is classified identically no matter which host routed it.
 *
 * Escape hatches: `ORBITER_HOOK_POLICY=v1` re-runs the flat v1 string ruleset over the
 * caller-provided legacy strings; `legacy` re-runs the original hardcoded classifier.
 */
export function evaluateHostToolRiskWithPolicy(
  host: GenericPolicyHost,
  toolName: string,
  args: Record<string, unknown>,
  legacyAction: string,
  legacyContent: string,
): CodexRiskLevel {
  const mode = hookPolicyMode();
  if (mode === 'legacy') return evaluateCodexRisk(legacyAction, legacyContent);
  if (mode === 'v1') return evaluateRuleset(DEFAULT_RISK_RULESET, { action: legacyAction, content: legacyContent }) as CodexRiskLevel;
  return evaluateRulesetV2(genericRulesetV2For(host), { toolName, args }).level as CodexRiskLevel;
}

function containsAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle.toLowerCase()));
}
