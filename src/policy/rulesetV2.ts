/**
 * Policy-as-data ruleset **v2** (hosted-hooks paper, Tier-1.5). The flat v1 ruleset
 * (`ruleset.ts`) matches only `action`/`content` strings and returns a bare risk level -
 * enough to express the codex/gemini classifiers, but NOT the antigravity classifier, which
 * is tool-name-aware (browser/MCP/subagent/schedule/ask_permission), path-pattern-aware,
 * workspace-boundary-aware, and returns structured `{ level, reasons, flags }`.
 *
 * v2 adds, as DATA:
 *   - tool-name rules (exact set + prefix, e.g. "browser_", "mcp_")
 *   - an optional arg-value gate per rule (e.g. manage_task Action ∈ {kill, send_input})
 *   - regex/contains rules matched against an extracted field (command / target / searchable)
 *   - a structural workspace-boundary check (primary target outside the workspace → risk)
 *   - structured output (level + reasons + flags), highest-matched-risk wins
 *
 * The extraction keys (which arg fields carry the command / the target path) are themselves
 * part of the ruleset, so the policy stays serializable and self-contained (no import of the
 * adapter it will eventually replace). `DEFAULT_ANTIGRAVITY_RULESET_V2` reproduces
 * `src/antigravity/risk.ts`'s intent as data; `policy-equivalence-v2.test.js` proves the
 * interpreted level matches the legacy classifier across a corpus (the prerequisite for
 * wiring the adapter behind the `ORBITER_HOOK_POLICY=data` flag).
 *
 * Additive and self-contained: NOT yet wired into the live antigravity adapter. Kept
 * dependency-free (only `RiskLevel`/`maxRisk` from the sibling v1 module) so it can run
 * server-side as well.
 */

import { type RiskLevel, maxRisk } from './ruleset.js';

export type { RiskLevel };
export { maxRisk };

/** Structured risk result - matches the antigravity adapter's evaluation shape. */
export interface StructuredRisk {
  level: RiskLevel;
  reasons: string[];
  flags: string[];
}

/** Which extracted field a contains/regex matcher tests against. Default 'searchable'. */
export type RuleField = 'toolName' | 'command' | 'target' | 'searchable';

export interface RiskRuleV2 {
  /** Stable id for audit / decision logs. */
  id: string;
  /** Risk contributed when this rule matches (combined via highest-wins). */
  risk: RiskLevel;
  /** Human reason pushed when matched. `{tool}` is replaced with the tool name. */
  reason: string;
  /** Short machine flag pushed when matched (e.g. 'browser_automation'). */
  flag: string;
  /** Exact tool-name membership (OR'd with other matchers). */
  toolNames?: string[];
  /** Tool-name prefixes; matches the bare name or `${prefix}_...` (e.g. "browser"). */
  toolNamePrefixes?: string[];
  /** Optional tool-name allow-gate (AND'd): rule only applies to these tool names (case-insensitive). */
  onlyToolNames?: string[];
  /** Optional tool-name deny-gate (AND'd): rule is skipped for these tool names (case-insensitive). */
  excludeToolNames?: string[];
  /** Case-insensitive substrings matched against `field`. */
  contains?: string[];
  /** Regex sources (compiled case-insensitive) matched against `field`. */
  regex?: string[];
  /** Field for contains/regex matchers. Default 'searchable'. */
  field?: RuleField;
  /**
   * Optional gate: the rule only applies when args[argKey] (lowercased) is in `equalsLower`.
   * Matchers are OR'd; the `when` gate is AND'd on top. A rule with only a gate (no matcher)
   * applies whenever the gate passes.
   */
  when?: { argKey: string; equalsLower: string[] };
}

/** Structural workspace-boundary check (cannot be a pure regex rule). */
export interface WorkspaceBoundaryRule {
  enabled: boolean;
  risk: RiskLevel;
  reason: string;
  flag: string;
}

/** Declares which arg keys hold the command and the primary target path. */
export interface ExtractConfig {
  commandKeys: string[];
  targetKeys: string[];
}

export interface RiskRulesetV2 {
  /** Bundle version for ETag / staged rollout (signed, versioned ruleset). */
  version: string;
  /** Default level when no rule matches. */
  default: RiskLevel;
  /** How to pull the command / target out of the tool args. */
  extract: ExtractConfig;
  /** Rules; the HIGHEST matched risk wins (fail-safe toward stricter). */
  rules: RiskRuleV2[];
  /** Optional structural workspace-boundary check. */
  workspaceBoundary?: WorkspaceBoundaryRule;
  /** Passive/read-only tools: emit a 'passive' flag if nothing else matched. */
  passiveTools?: string[];
}

export interface RulesetV2Input {
  toolName: string;
  args: Record<string, unknown>;
  workspacePaths?: string[];
}

// --- interpreter internals (generic, not policy) ---------------------------------------

function safeTest(source: string, value: string): boolean {
  try {
    return new RegExp(source, 'i').test(value);
  } catch {
    return false;
  }
}

/** Deterministic, sorted-key serialization (matches the adapter's `stableStringify`). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function looksPathLike(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('./') || value.startsWith('../');
}

function normalizePath(value: string): string {
  return value
    .replace(/^[A-Za-z]:/, '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function isInsideAnyWorkspace(target: string, workspacePaths: string[]): boolean {
  if (!workspacePaths.length || !looksPathLike(target)) return true;
  const normalizedTarget = normalizePath(target);
  return workspacePaths.some((workspace) => {
    const normalizedWorkspace = normalizePath(workspace);
    return normalizedTarget === normalizedWorkspace || normalizedTarget.startsWith(`${normalizedWorkspace}/`);
  });
}

function extractCommand(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function extractTarget(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && looksPathLike(value)) return value;
  }
  return undefined;
}

interface MatchContext {
  toolName: string;
  args: Record<string, unknown>;
  command: string;
  target: string;
  searchable: string;
}

function fieldValue(ctx: MatchContext, field: RuleField): string {
  switch (field) {
    case 'toolName':
      return ctx.toolName;
    case 'command':
      return ctx.command;
    case 'target':
      return ctx.target;
    default:
      return ctx.searchable;
  }
}

function ruleMatches(rule: RiskRuleV2, ctx: MatchContext): boolean {
  const toolLower = ctx.toolName.toLowerCase();
  if (rule.onlyToolNames && !rule.onlyToolNames.some((name) => name.toLowerCase() === toolLower)) {
    return false;
  }
  if (rule.excludeToolNames && rule.excludeToolNames.some((name) => name.toLowerCase() === toolLower)) {
    return false;
  }
  if (rule.when) {
    const v = ctx.args[rule.when.argKey];
    const lv = typeof v === 'string' ? v.toLowerCase() : '';
    if (!rule.when.equalsLower.includes(lv)) return false;
  }
  let hasMatcher = false;
  if (rule.toolNames) {
    hasMatcher = true;
    if (rule.toolNames.includes(ctx.toolName)) return true;
  }
  if (rule.toolNamePrefixes) {
    hasMatcher = true;
    if (rule.toolNamePrefixes.some((p) => ctx.toolName === p || ctx.toolName.startsWith(`${p}_`))) return true;
  }
  const hay = fieldValue(ctx, rule.field ?? 'searchable');
  if (rule.contains) {
    hasMatcher = true;
    if (rule.contains.some((s) => hay.toLowerCase().includes(s.toLowerCase()))) return true;
  }
  if (rule.regex) {
    hasMatcher = true;
    if (rule.regex.some((r) => safeTest(r, hay))) return true;
  }
  // A gate-only rule (no matchers) applies whenever the gate above passed.
  return !hasMatcher;
}

/**
 * Interpret a v2 ruleset over a tool call. Highest matched risk wins; reasons/flags
 * accumulate. Reproduces the antigravity classifier's structured output as data.
 */
export function evaluateRulesetV2(ruleset: RiskRulesetV2, input: RulesetV2Input): StructuredRisk {
  const args = input.args ?? {};
  const command = extractCommand(args, ruleset.extract.commandKeys) ?? '';
  const target = extractTarget(args, ruleset.extract.targetKeys) ?? '';
  const searchable = `${input.toolName}\n${command}\n${target}\n${stableStringify(args)}`;
  const ctx: MatchContext = { toolName: input.toolName, args, command, target, searchable };

  let level: RiskLevel = ruleset.default;
  const reasons: string[] = [];
  const flags: string[] = [];

  for (const rule of ruleset.rules) {
    if (!ruleMatches(rule, ctx)) continue;
    level = maxRisk(level, rule.risk);
    reasons.push(rule.reason.replace('{tool}', input.toolName));
    flags.push(rule.flag);
  }

  const wb = ruleset.workspaceBoundary;
  if (wb?.enabled && target && !isInsideAnyWorkspace(target, input.workspacePaths ?? [])) {
    level = maxRisk(level, wb.risk);
    reasons.push(wb.reason);
    flags.push(wb.flag);
  }

  if (reasons.length === 0 && ruleset.passiveTools?.some((name) => name.toLowerCase() === input.toolName.toLowerCase())) {
    reasons.push('Passive workspace-scoped operation.');
    flags.push('passive');
  }

  return { level, reasons, flags };
}

// --- DEFAULT_ANTIGRAVITY_RULESET_V2 -----------------------------------------------------
//
// The regex sources below are authored as RegExp literals (so no hand-escaping is needed)
// and serialized to `.source` strings when assembled into the ruleset - the published
// bundle is therefore plain, JSON-serializable data, while staying byte-faithful to the
// legacy patterns in `src/antigravity/risk.ts`. The v2 equivalence test is the drift guard.

const CRITICAL_COMMAND_PATTERNS = [
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

const HIGH_RISK_COMMAND_PATTERNS = [
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

const CREDENTIAL_PATH_PATTERNS = [
  /(^|[\\/\s"'])\.env(?:\.|$)/i,
  /(^|[\\/])\.ssh(?:[\\/]|$)/i,
  /(^|[\\/\s"'])(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\s|$|[\\/"'])/i,
  /(^|[\\/\s"'])(?:\.npmrc|\.pypirc|\.netrc)(?:\s|$|[\\/"'])/i,
  /(^|[\\/])secrets?(?:[\\/._-]|$)/i,
  /(^|[\\/])credentials?(?:[\\/._-]|$)/i,
  /\.(?:pem|key|p8|p12)(?:\s|$|["'])/i,
];

const RELEASE_GOVERNANCE_PATH_PATTERNS = [
  /(^|[\\/])\.git(?:[\\/]|$)/i,
  /release_manifest\.json(?:\s|$|["'])/i,
  /release_ledger\.md(?:\s|$|["'])/i,
  /secret_register\.json(?:\s|$|["'])/i,
];

const SENSITIVE_PATH_PATTERNS = [
  ...CREDENTIAL_PATH_PATTERNS,
  ...RELEASE_GOVERNANCE_PATH_PATTERNS,
];

const MEDIUM_PATH_PATTERNS = [
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

const sources = (patterns: RegExp[]): string[] => patterns.map((p) => p.source);

const MUTATING_TOOLS = [
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
];

const SUBAGENT_TOOLS = ['invoke_subagent', 'define_subagent'];
const NETWORK_READ_TOOLS = ['read_url_content', 'search_web'];
const READ_ONLY_FILE_TOOLS = [
  'view_file',
  'read_file',
  'list_dir',
  'view_file_outline',
  'view_code_item',
  'read_resource',
];
const PASSIVE_TOOLS = [
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
];

export const DEFAULT_ANTIGRAVITY_RULESET_V2: RiskRulesetV2 = {
  version: '2026-11-24.1',
  default: 'low',
  extract: {
    commandKeys: ['CommandLine', 'command', 'cmd', 'script'],
    targetKeys: [
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
    ],
  },
  rules: [
    {
      id: 'terminal',
      risk: 'medium',
      toolNames: ['run_command'],
      reason: 'Terminal command execution can mutate local state or external systems.',
      flag: 'terminal',
    },
    {
      id: 'mutating-tool',
      risk: 'medium',
      toolNames: MUTATING_TOOLS,
      reason: 'Antigravity tool {tool} can modify state or grant capability.',
      flag: 'mutating_tool',
    },
    {
      id: 'browser-automation',
      risk: 'high',
      toolNamePrefixes: ['browser'],
      reason: 'Browser automation can execute remote-page actions or expose authenticated page context.',
      flag: 'browser_automation',
    },
    {
      id: 'mcp-tool',
      risk: 'high',
      toolNamePrefixes: ['mcp'],
      reason: 'MCP tool execution can cross local agent boundaries or invoke external integrations.',
      flag: 'mcp_tool',
    },
    {
      id: 'task-control',
      risk: 'high',
      toolNames: ['manage_task'],
      when: { argKey: 'Action', equalsLower: ['kill', 'send_input'] },
      reason: 'Task management can interrupt or steer active autonomous execution.',
      flag: 'task_control',
    },
    {
      id: 'scheduled-task',
      risk: 'high',
      toolNames: ['schedule'],
      reason: 'Scheduled tasks create delayed or recurring autonomous execution.',
      flag: 'scheduled_task',
    },
    {
      id: 'permission-grant',
      risk: 'high',
      toolNames: ['ask_permission'],
      reason: 'Permission grant requests can broaden agent capability.',
      flag: 'permission_grant',
    },
    {
      id: 'subagent',
      risk: 'high',
      toolNames: SUBAGENT_TOOLS,
      reason: 'Subagent operations can create parallel autonomous work.',
      flag: 'subagent',
    },
    {
      id: 'critical-command',
      risk: 'critical',
      excludeToolNames: PASSIVE_TOOLS,
      regex: sources(CRITICAL_COMMAND_PATTERNS),
      reason: 'Command matches a destructive critical-risk pattern.',
      flag: 'critical_command',
    },
    {
      id: 'high-risk-command',
      risk: 'high',
      excludeToolNames: PASSIVE_TOOLS,
      regex: sources(HIGH_RISK_COMMAND_PATTERNS),
      reason: 'Command matches a high-risk publish, deploy, database, privilege, or git operation.',
      flag: 'high_risk_command',
    },
    {
      id: 'sensitive-path',
      risk: 'critical',
      excludeToolNames: PASSIVE_TOOLS,
      regex: sources(SENSITIVE_PATH_PATTERNS),
      reason: 'Tool arguments reference a sensitive or release-critical path.',
      flag: 'sensitive_path',
    },
    {
      id: 'sensitive-read-path',
      risk: 'critical',
      onlyToolNames: READ_ONLY_FILE_TOOLS,
      field: 'target',
      regex: sources(CREDENTIAL_PATH_PATTERNS),
      reason: 'Read-only tool targets a sensitive credential or private-key path.',
      flag: 'sensitive_path',
    },
    {
      id: 'configuration-path',
      risk: 'medium',
      excludeToolNames: PASSIVE_TOOLS,
      regex: sources(MEDIUM_PATH_PATTERNS),
      reason: 'Tool arguments reference dependency, migration, workflow, or container configuration.',
      flag: 'configuration_path',
    },
    {
      id: 'network-read',
      risk: 'medium',
      toolNames: NETWORK_READ_TOOLS,
      reason: 'External network research can leak intent or introduce prompt-injected content.',
      flag: 'network_read',
    },
  ],
  workspaceBoundary: {
    enabled: true,
    risk: 'high',
    reason: 'Primary target appears outside Antigravity project workspace paths.',
    flag: 'outside_workspace',
  },
  passiveTools: PASSIVE_TOOLS,
};
