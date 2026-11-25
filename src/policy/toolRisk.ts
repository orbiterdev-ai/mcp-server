/**
 * Shared tool-call risk classifier for the Claude Code surfaces (the `permission-check`
 * hook and the MCP permission relay).
 *
 * Before this module existed, each Claude surface carried its own ad-hoc keyword
 * heuristic, so the SAME command could be labeled three different risk levels depending
 * on which integration routed it (Claude hook vs. permission relay vs. Codex/Gemini
 * ruleset). That breaks the product's core determinism promise: same action, same rule,
 * same answer - on every surface.
 *
 * Data mode (the default) interprets the SAME versioned ruleset the Codex and Gemini
 * hooks use (`DEFAULT_RISK_RULESET`), with the command extracted from the tool input the
 * same way the Codex normalizer extracts it. `ORBITER_HOOK_POLICY=legacy` falls back to
 * the pre-unification Claude heuristic (kept verbatim below as the rollback escape hatch,
 * mirroring codex/risk.ts and antigravity/risk.ts).
 */

import { evaluateRuleset, DEFAULT_RISK_RULESET, hookPolicyMode, type RiskLevel } from './ruleset.js';
import { evaluateRulesetV2 } from './rulesetV2.js';
import { genericRulesetV2For } from './genericRulesetV2.js';

/** Arg keys that may carry the executable command, matching the Codex/Gemini extractors. */
const COMMAND_KEYS = ['command', 'CommandLine', 'cmd', 'script'];

function extractCommand(inputJson: string): string {
  try {
    const parsed = JSON.parse(inputJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const key of COMMAND_KEYS) {
        const value = (parsed as Record<string, unknown>)[key];
        if (typeof value === 'string') return value;
      }
    }
  } catch {
    // Non-JSON input - classify over the raw string below.
  }
  return '';
}

function parseArgs(inputJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(inputJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Non-JSON input - wrap it so the searchable field still covers the raw string.
  }
  return { raw: inputJson };
}

/**
 * Classify a tool call's risk from its name and raw input JSON.
 *
 * Default is the converged ruleset v2 (generic rule table, 'claude' extract config) -
 * the same engine and input shape as the Codex/Gemini/Antigravity hooks, so a command is
 * classified identically on every surface. `ORBITER_HOOK_POLICY=v1` interprets the flat
 * v1 string ruleset; `legacy` restores the pre-unification Claude heuristic.
 */
export function computeToolRisk(toolName: string, toolInputJson: string): RiskLevel {
  const mode = hookPolicyMode();
  if (mode === 'legacy') {
    return legacyClaudeToolRisk(toolName, toolInputJson);
  }
  if (mode === 'v1') {
    const command = extractCommand(toolInputJson);
    const action = command ? `${toolName}: ${command}` : toolName;
    return evaluateRuleset(DEFAULT_RISK_RULESET, { action, content: toolInputJson });
  }
  return evaluateRulesetV2(genericRulesetV2For('claude'), { toolName, args: parseArgs(toolInputJson) }).level;
}

/**
 * The pre-unification Claude Code heuristic, preserved byte-for-byte in intent for
 * `ORBITER_HOOK_POLICY=legacy`. Do not extend this - add rules to the ruleset instead.
 */
export function legacyClaudeToolRisk(toolName: string, inputJson: string): RiskLevel {
  const lowerName = toolName.toLowerCase();
  const lowerInput = inputJson.toLowerCase();

  // Critical: Database destruction or production teardown
  const criticalPatterns = [
    'drop table', 'drop database', 'truncate', 'delete from',
    'rm -rf /', 'format c:', 'destroy production', 'drop production',
    'delete all', 'wipe', 'nuke',
  ];
  for (const pattern of criticalPatterns) {
    if (lowerInput.includes(pattern)) return 'critical';
  }

  // High: Destructive shell commands or high-risk tool names
  if (lowerName.includes('bash') || lowerName.includes('computer_use')) {
    const highRiskKeywords = ['rm', 'drop', 'delete', 'kill', 'truncate', 'format', 'sudo', 'chmod', 'chown'];
    for (const kw of highRiskKeywords) {
      if (lowerInput.match(new RegExp(`\\b${kw}\\b`))) {
        return 'high';
      }
    }
  }

  // Medium: Any file-mutating tool
  if (lowerName.includes('write') || lowerName.includes('edit') || lowerName.includes('bash') || lowerName.includes('str_replace')) {
    return 'medium';
  }

  return 'low';
}
