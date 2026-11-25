import type { AntigravityHookProfile, AntigravityRiskEvaluation, AntigravityRiskLevel } from './types.js';
import { isRecord, stableStringify } from '../codex/json.js';
import { evaluateRulesetV2, DEFAULT_ANTIGRAVITY_RULESET_V2 } from '../policy/rulesetV2.js';
import { hookPolicyMode, meetsMinRisk, resolveMinRisk } from '../policy/ruleset.js';

const readOnlyFileTools = new Set([
  'view_file',
  'read_file',
  'list_dir',
  'view_file_outline',
  'view_code_item',
  'read_resource',
]);

const passiveTools = new Set([
  'view_file',
  'read_file',
  'list_dir',
  'find_by_name',
  'grep_search',
  'view_file_outline',
  'view_code_item',
  'list_permissions',
  'list_resources',
  'read_resource',
  'list_plugin_accounts',
  'ask_question',
  'update_focus',
  'update_steps',
  'send_message',
  'manage_subagents',
  'manage_task',
]);

const mutatingTools = new Set([
  'run_command',
  'write_to_file',
  'write_file',
  'replace_file_content',
  'multi_replace_file_content',
  'edit_file',
  'schedule',
  'ask_permission',
  'invoke_subagent',
  'define_subagent',
  'generate_image',
]);

const networkReadTools = new Set([
  'read_url_content',
  'search_web',
]);

const subagentTools = new Set([
  'invoke_subagent',
  'define_subagent',
]);

const criticalCommandPatterns = [
  /\brm\s+-rf\s+(?:\/(?:\s|["']|$)|\/\*|[a-z]:\\)/i,
  /\brm\s+-rf\s+(?:\.{1,2}(?:[\\/]\s*|\s|$)|\*)/i,
  /\bremove-item\b[\s\S]*\b-recurse\b[\s\S]*(?:[a-z]:\\|\/(?:\s|["']|$))/i,
  /\b(?:rd|rmdir)\s+\/s\b[\s\S]*(?:[a-z]:\\|\\\*|\.\s*$)/i,
  /\bformat\s+[a-z]:/i,
  /\bdel\s+\/[a-z]*[fsq][a-z]*\s+[a-z]:\\/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bgit\s+checkout\s+--\b/i,
  /\bgit\s+restore\b/i,
  /\bdocker\s+(?:compose\s+)?down\b[\s\S]*\s-v\b/i,
  /\bdocker\s+system\s+prune\b[\s\S]*\s-a\b/i,
];

const highRiskCommandPatterns = [
  /\bnpm\s+publish\b/i,
  /\bnpm\s+(?:version|deprecate|unpublish)\b/i,
  /\bnpm\s+audit\s+fix\b[\s\S]*--force\b/i,
  /\bpnpm\s+publish\b/i,
  /\bpnpm\s+(?:deploy|version)\b/i,
  /\byarn\s+npm\s+publish\b/i,
  /\byarn\s+(?:npm\s+)?(?:publish|version)\b/i,
  /\bgit\s+push\b/i,
  /\bgit\s+(?:branch\s+-D|worktree\s+remove|checkout\b|switch\b)/i,
  /\bwrangler\s+deploy\b/i,
  /\bwrangler\s+d1\s+execute\b/i,
  /\bcloudflare\s+(?:deploy|d1\s+execute)\b/i,
  /\bfly\s+deploy\b/i,
  /\bvercel\s+(?:deploy|--prod)\b/i,
  /\brailway\s+(?:up|deploy)\b/i,
  /\bsupabase\s+db\s+push\b/i,
  /\bsupabase\s+db\s+reset\b/i,
  /\bterraform\s+apply\b/i,
  /\bterraform\s+destroy\b/i,
  /\btofu\s+(?:apply|destroy)\b/i,
  /\bprisma\s+(?:migrate\s+deploy|db\s+push)\b/i,
  /\bdrizzle-kit\s+(?:push|migrate)\b/i,
  /\bkubectl\s+(?:apply|delete|patch|replace|scale|rollout)\b/i,
  /\bhelm\s+(?:install|upgrade|rollback|uninstall)\b/i,
  /\b(?:aws|gcloud|az)\b[\s\S]*\b(?:delete|remove|destroy|put|update|create|deploy)\b/i,
  /\bdocker\s+(?:push|buildx\s+build[\s\S]*--push)\b/i,
  /\bdrop\s+table\b/i,
  /\bdrop\s+database\b/i,
  /\btruncate\s+table\b/i,
  /\bdelete\s+from\b/i,
  /\bsudo\b/i,
];

const credentialPathPatterns = [
  /(^|[\\/\s"'])\.env(?:\.|$)/i,
  /(^|[\\/])\.ssh(?:[\\/]|$)/i,
  /(^|[\\/\s"'])(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\s|$|[\\/"'])/i,
  /(^|[\\/\s"'])(?:\.npmrc|\.pypirc|\.netrc)(?:\s|$|[\\/"'])/i,
  /(^|[\\/])secrets?(?:[\\/._-]|$)/i,
  /(^|[\\/])credentials?(?:[\\/._-]|$)/i,
  /\.(?:pem|key|p8|p12)(?:\s|$|["'])/i,
];

const releaseGovernancePathPatterns = [
  /(^|[\\/])\.git(?:[\\/]|$)/i,
  /release_manifest\.json(?:\s|$|["'])/i,
  /release_ledger\.md(?:\s|$|["'])/i,
  /secret_register\.json(?:\s|$|["'])/i,
];

const sensitivePathPatterns = [
  ...credentialPathPatterns,
  ...releaseGovernancePathPatterns,
];

const mediumRiskPathPatterns = [
  /package\.json(?:\s|$|["'])/i,
  /package-lock\.json(?:\s|$|["'])/i,
  /pnpm-lock\.yaml(?:\s|$|["'])/i,
  /go\.mod(?:\s|$|["'])/i,
  /Cargo\.toml(?:\s|$|["'])/i,
  /Package\.resolved(?:\s|$|["'])/i,
  /(^|[\\/])migrations?[\\/]/i,
  /(^|[\\/])\.github[\\/]workflows[\\/]/i,
  /(^|[\\/])\.agents[\\/](?:hooks\.json(?:\s|$|["'])|rules[\\/]|workflows[\\/])/i,
  /(^|[\\/])\.gemini[\\/]config[\\/](?:hooks\.json|mcp_config\.json)(?:\s|$|["'])/i,
  /(^|[\\/])(?:AGENTS|GEMINI|PROJECT)\.md(?:\s|$|["'])/i,
  /Dockerfile(?:\s|$|["'])/i,
];

export function evaluateAntigravityRisk(
  toolName: string,
  args: Record<string, unknown>,
  workspacePaths: string[] = [],
): AntigravityRiskEvaluation {
  const reasons: string[] = [];
  const flags: string[] = [];
  let level: AntigravityRiskLevel = 'low';
  const command = extractCommand(args);
  const target = extractPrimaryTarget(args);
  const searchable = `${toolName}\n${command || ''}\n${target || ''}\n${stableStringify(args)}`;

  if (toolName === 'run_command') {
    level = maxRisk(level, 'medium');
    reasons.push('Terminal command execution can mutate local state or external systems.');
    flags.push('terminal');
  }

  if (mutatingTools.has(toolName)) {
    level = maxRisk(level, 'medium');
    reasons.push(`Antigravity tool ${toolName} can modify state or grant capability.`);
    flags.push('mutating_tool');
  }

  if (isBrowserTool(toolName)) {
    level = maxRisk(level, 'high');
    reasons.push('Browser automation can execute remote-page actions or expose authenticated page context.');
    flags.push('browser_automation');
  }

  if (isMcpTool(toolName)) {
    level = maxRisk(level, 'high');
    reasons.push('MCP tool execution can cross local agent boundaries or invoke external integrations.');
    flags.push('mcp_tool');
  }

  if (toolName === 'manage_task') {
    const action = lowerString(args.Action);
    if (action === 'kill' || action === 'send_input') {
      level = maxRisk(level, 'high');
      reasons.push('Task management can interrupt or steer active autonomous execution.');
      flags.push('task_control');
    }
  }

  if (toolName === 'schedule') {
    level = maxRisk(level, 'high');
    reasons.push('Scheduled tasks create delayed or recurring autonomous execution.');
    flags.push('scheduled_task');
  }

  if (toolName === 'ask_permission') {
    level = maxRisk(level, 'high');
    reasons.push('Permission grant requests can broaden agent capability.');
    flags.push('permission_grant');
  }

  if (subagentTools.has(toolName)) {
    level = maxRisk(level, 'high');
    reasons.push('Subagent operations can create parallel autonomous work.');
    flags.push('subagent');
  }

  const isPassiveOrCoordination = passiveTools.has(toolName);

  if (!isPassiveOrCoordination) {
    if (criticalCommandPatterns.some((pattern) => pattern.test(searchable))) {
      level = 'critical';
      reasons.push('Command matches a destructive critical-risk pattern.');
      flags.push('critical_command');
    } else if (highRiskCommandPatterns.some((pattern) => pattern.test(searchable))) {
      level = maxRisk(level, 'high');
      reasons.push('Command matches a high-risk publish, deploy, database, privilege, or git operation.');
      flags.push('high_risk_command');
    }

    if (sensitivePathPatterns.some((pattern) => pattern.test(searchable))) {
      level = maxRisk(level, 'critical');
      reasons.push('Tool arguments reference a sensitive or release-critical path.');
      flags.push('sensitive_path');
    } else if (mediumRiskPathPatterns.some((pattern) => pattern.test(searchable))) {
      level = maxRisk(level, 'medium');
      reasons.push('Tool arguments reference dependency, migration, workflow, or container configuration.');
      flags.push('configuration_path');
    }
  } else if (readOnlyFileTools.has(toolName) && target && credentialPathPatterns.some((pattern) => pattern.test(target))) {
    level = maxRisk(level, 'critical');
    reasons.push('Read-only tool targets a sensitive credential or private-key path.');
    flags.push('sensitive_path');
  }

  if (target && !isInsideAnyWorkspace(target, workspacePaths)) {
    level = maxRisk(level, 'high');
    reasons.push('Primary target appears outside Antigravity project workspace paths.');
    flags.push('outside_workspace');
  }

  if (networkReadTools.has(toolName)) {
    level = maxRisk(level, 'medium');
    reasons.push('External network research can leak intent or introduce prompt-injected content.');
    flags.push('network_read');
  }

  if (passiveTools.has(toolName) && reasons.length === 0) {
    reasons.push('Passive workspace-scoped operation.');
    flags.push('passive');
  }

  return { level, reasons, flags };
}

/**
 * Policy-aware antigravity risk evaluation. **Default is now policy-as-data**: route through
 * ruleset v2 (structured {level, reasons, flags}; level-parity with the legacy classifier is
 * proven by `policy-equivalence-v2.test.js`). Set `ORBITER_HOOK_POLICY=legacy` to fall back to
 * the hardcoded classifier (the rollback escape hatch). Mirrors `evaluateCodexRiskWithPolicy`.
 */
export function evaluateAntigravityRiskWithPolicy(
  toolName: string,
  args: Record<string, unknown>,
  workspacePaths: string[] = [],
): AntigravityRiskEvaluation {
  if (hookPolicyMode() === 'legacy') {
    return evaluateAntigravityRisk(toolName, args, workspacePaths);
  }
  return evaluateRulesetV2(DEFAULT_ANTIGRAVITY_RULESET_V2, {
    toolName,
    args,
    workspacePaths,
  }) as AntigravityRiskEvaluation;
}

export function antigravityRiskRequiresApproval(
  toolName: string,
  risk: AntigravityRiskEvaluation,
  profile: AntigravityHookProfile,
): boolean {
  if (profile === 'observe') return false;
  if (risk.level === 'critical') return false;
  // B-118: shared threshold acts as a FLOOR on top of the tool-identity rules below.
  // Antigravity historically escalated on tool identity alone (a low-risk `run_command`
  // still routed), so the default stays 'low' and nothing changes unless ORBITER_MIN_RISK
  // is set. With it set to e.g. 'high', low/medium are allowed locally as on Codex.
  if (!meetsMinRisk(risk.level, resolveMinRisk('low'))) return false;
  if (profile === 'strict') return toolName !== 'list_permissions' && toolName !== 'ask_question';
  if (toolName === 'run_command') return true;
  if (mutatingTools.has(toolName)) return true;
  if (networkReadTools.has(toolName)) return true;
  if (isBrowserTool(toolName) || isMcpTool(toolName)) return true;
  if (risk.flags.some((flag) => flag === 'network_read' || flag === 'outside_workspace')) return true;
  return risk.level === 'high';
}

export function isCriticalAntigravityRisk(risk: AntigravityRiskEvaluation): boolean {
  return risk.level === 'critical';
}

function extractCommand(args: Record<string, unknown>): string | undefined {
  const value = args.CommandLine ?? args.command ?? args.cmd ?? args.script;
  return typeof value === 'string' ? value : undefined;
}

function extractPrimaryTarget(args: Record<string, unknown>): string | undefined {
  const keys = [
    'TargetFile',
    'AbsolutePath',
    'Path',
    'FilePath',
    'file_path',
    'path',
    'DirectoryPath',
    'SearchDirectory',
    'SearchPath',
    'Cwd',
    'Target',
  ];
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && looksPathLike(value)) return value;
  }
  return undefined;
}

function looksPathLike(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('./') || value.startsWith('../');
}

function isBrowserTool(toolName: string): boolean {
  return toolName === 'browser' || toolName.startsWith('browser_');
}

function isMcpTool(toolName: string): boolean {
  return toolName === 'mcp' || toolName.startsWith('mcp_');
}

function lowerString(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function isInsideAnyWorkspace(target: string, workspacePaths: string[]): boolean {
  if (!workspacePaths.length || !looksPathLike(target)) return true;
  const normalizedTarget = normalizePath(target);
  return workspacePaths.some((workspace) => {
    const normalizedWorkspace = normalizePath(workspace);
    return normalizedTarget === normalizedWorkspace || normalizedTarget.startsWith(`${normalizedWorkspace}/`);
  });
}

function normalizePath(value: string): string {
  return value.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function maxRisk(a: AntigravityRiskLevel, b: AntigravityRiskLevel): AntigravityRiskLevel {
  const order: Record<AntigravityRiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };
  return order[a] >= order[b] ? a : b;
}

export function recordFromArgs(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
