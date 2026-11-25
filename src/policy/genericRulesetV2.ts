/**
 * Generic ruleset **v2** for the former v1 surfaces (Claude Code, Codex, Gemini CLI) -
 * the Tier-1.5 convergence step: ONE rule table, interpreted by the same v2 engine the
 * Antigravity adapter already uses, with per-host `extract` configs describing where each
 * host's tool args carry the command and the target path.
 *
 * The rules reproduce `DEFAULT_RISK_RULESET` (v1)'s intent as v2 data. Two deliberate
 * differences from how v1 was *fed* (both determinism wins, both >= v1 in strictness for
 * real tool calls):
 *   - Matching runs over the tool call itself (toolName + extracted command/target +
 *     stable-stringified args), not over display strings (descriptions, diff summaries)
 *     whose wording could trip content rules.
 *   - v1's action-targeted deploy rule matches the 'searchable' field here, because v2
 *     hosts do not synthesize an action string; over-matching toward stricter is the
 *     fail-safe direction.
 *
 * `policy-generic-v2.test.js` proves: same command → same level across hosts, level >= v1
 * over the proof corpus, and per-host extract keys are honored.
 */

import type { ExtractConfig, RiskRuleV2, RiskRulesetV2 } from './rulesetV2.js';

export type GenericPolicyHost = 'claude' | 'codex' | 'gemini';

// Byte-faithful to policy/ruleset.ts CRITICAL_DESTRUCTION_PATTERNS (authored as RegExp
// literals, serialized to .source so the bundle stays plain JSON data).
const CRITICAL_DESTRUCTION_PATTERNS = [
  /\brm\s+-rf\s+(?:\/(?:\s|["']|$)|\/\*|[a-z]:\\)/i,
  /\bremove-item\b[\s\S]*\b-recurse\b[\s\S]*(?:[a-z]:\\|\/(?:\s|["']|$))/i,
  /\bformat\s+[a-z]:/i,
  /\bdel\s+\/[a-z]*[fsq][a-z]*\s+[a-z]:\\/i,
];

const sources = (patterns: RegExp[]): string[] => patterns.map((p) => p.source);

// Read-only file inspection tools across Claude Code, Codex, Gemini CLI, Cursor, and Antigravity.
const READ_ONLY_FILE_GENERIC_TOOLS = [
  'Read',
  'read_file',
  'view_file',
  'LS',
  'list_dir',
  'NotebookRead',
  'view_file_outline',
  'view_code_item',
  'view_image',
];

// Read-only search and internal agent-coordination tools whose free-text queries or messages
// must never trip shell/DB destruction or config-mutation rules (ORB-33).
const READ_ONLY_AND_COORDINATION_GENERIC_TOOLS = [
  ...READ_ONLY_FILE_GENERIC_TOOLS,
  'Glob',
  'Grep',
  'TodoRead',
  'TodoWrite',
  'find_by_name',
  'grep_search',
  'grep_files',
  'file_search',
  'codebase_search',
  'read_lints',
  'manage_subagents',
  'send_message',
  'update_focus',
  'update_steps',
  'ask_question',
  'list_permissions',
  'list_resources',
  'read_resource',
];

const SECRET_MARKERS = [
  'private key',
  'aws_secret',
  'api_key',
  '.env',
  '.pem',
  '.key',
  'secrets.',
  'credentials.',
  'production.yaml',
];

const GENERIC_RULES: RiskRuleV2[] = [
  {
    id: 'critical-destruction',
    risk: 'critical',
    excludeToolNames: READ_ONLY_AND_COORDINATION_GENERIC_TOOLS,
    regex: sources(CRITICAL_DESTRUCTION_PATTERNS),
    reason: 'Command matches a recursive/forced delete or drive-format pattern targeting a root or drive path.',
    flag: 'critical_destruction',
  },
  {
    id: 'deploy-prod',
    risk: 'high',
    excludeToolNames: READ_ONLY_AND_COORDINATION_GENERIC_TOOLS,
    regex: ['(merge|deploy)[\\s\\S]*(main|master|prod)', '(main|master|prod)[\\s\\S]*(merge|deploy)'],
    reason: 'Tool call references a merge or deploy against a protected branch.',
    flag: 'deploy_prod',
  },
  {
    id: 'destructive-db',
    risk: 'high',
    excludeToolNames: READ_ONLY_AND_COORDINATION_GENERIC_TOOLS,
    contains: ['drop table', 'delete from', 'truncate table'],
    reason: 'Tool call contains a destructive database statement.',
    flag: 'destructive_db',
  },
  {
    id: 'secrets',
    risk: 'high',
    excludeToolNames: READ_ONLY_AND_COORDINATION_GENERIC_TOOLS,
    contains: SECRET_MARKERS,
    reason: 'Tool call references secret or credential material.',
    flag: 'secrets',
  },
  {
    id: 'secrets-read-target',
    risk: 'high',
    onlyToolNames: READ_ONLY_FILE_GENERIC_TOOLS,
    field: 'target',
    contains: SECRET_MARKERS,
    reason: 'Read-only file tool targets secret or credential material.',
    flag: 'secrets',
  },
  {
    id: 'destructive-shell',
    risk: 'high',
    excludeToolNames: READ_ONLY_AND_COORDINATION_GENERIC_TOOLS,
    contains: ['rm -rf', 'sudo', 'format', 'chmod -r 777', 'chown -r'],
    reason: 'Tool call contains a destructive or privilege-raising shell operation.',
    flag: 'destructive_shell',
  },
  {
    id: 'publish-push',
    risk: 'high',
    excludeToolNames: READ_ONLY_AND_COORDINATION_GENERIC_TOOLS,
    regex: ['\\bgit\\s+push\\b', '\\bgit\\s+reset\\b', '\\bgit\\s+clean\\b', '\\bnpm\\s+publish\\b'],
    reason: 'Tool call publishes or rewrites shared history.',
    flag: 'publish_push',
  },
  {
    id: 'pkg-manifests',
    risk: 'medium',
    excludeToolNames: READ_ONLY_AND_COORDINATION_GENERIC_TOOLS,
    contains: ['go.mod', 'package.json', 'cargo.toml', '.sql', 'dockerfile', 'migration', '.github/workflows'],
    reason: 'Tool call touches dependency, migration, workflow, or container configuration.',
    flag: 'pkg_manifests',
  },
  {
    id: 'remove-cmds',
    risk: 'medium',
    excludeToolNames: READ_ONLY_AND_COORDINATION_GENERIC_TOOLS,
    regex: ['\\b(rm|del|remove-item|erase|kill|stop-process)\\b'],
    reason: 'Tool call contains a removal or process-control command.',
    flag: 'remove_cmds',
  },
];

/**
 * Where each host's tool args carry the command and the primary target path. This is the
 * only part of the policy that differs per host; the rule table is shared.
 */
const HOST_EXTRACTS: Record<GenericPolicyHost, ExtractConfig> = {
  // Claude Code tool_input: Bash uses `command`; file tools use `file_path`/`notebook_path`.
  claude: {
    commandKeys: ['command', 'cmd', 'script'],
    targetKeys: ['file_path', 'notebook_path', 'path', 'target', 'target_file', 'relative_workspace_path', 'Path', 'AbsolutePath'],
  },
  // Codex tool_input: shell uses `command`; some runtimes surface `CommandLine`/`cmd`.
  codex: {
    commandKeys: ['command', 'CommandLine', 'cmd', 'script'],
    targetKeys: ['path', 'file_path', 'target', 'target_file', 'cwd', 'Path', 'AbsolutePath'],
  },
  // Gemini CLI tool_input: run_shell_command uses `command`; file tools use paths below.
  gemini: {
    commandKeys: ['command', 'CommandLine', 'cmd', 'script'],
    targetKeys: ['path', 'file_path', 'absolute_path', 'directory', 'Path', 'AbsolutePath'],
  },
};

const GENERIC_RULESET_VERSION = '2026-11-24.1';

export function genericRulesetV2For(host: GenericPolicyHost): RiskRulesetV2 {
  return {
    version: `${GENERIC_RULESET_VERSION}+${host}`,
    default: 'low',
    extract: HOST_EXTRACTS[host],
    rules: GENERIC_RULES,
    passiveTools: READ_ONLY_AND_COORDINATION_GENERIC_TOOLS,
  };
}
