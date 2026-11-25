import os from 'os';
import path from 'path';
import type { CodexApprovalStatus, CodexHookEventName } from './types.js';

export type CodexConfigHookProfile = 'minimal' | 'guarded' | 'full';
export type CodexConfigAdapter = 'mock' | 'file' | 'http';
export type CodexConfigBackendMode = 'missing' | 'offline-capture' | 'live-http' | 'mock' | 'file' | 'unknown';

export interface CodexConfigContext {
  cliPath: string;
}

export interface CodexConfigPatchOptions {
  adapter?: CodexConfigAdapter;
  mockDecision?: CodexApprovalStatus;
  serverUrl?: string;
  approvalTimeoutSeconds?: number;
  hookProfile?: CodexConfigHookProfile;
  offlineCapture?: boolean;
  captureDir?: string;
  /** 'ask' (default): critical routes to the phone; 'deny': local hard-deny. */
  criticalMode?: 'ask' | 'deny';
  /** Incomplete-decision policy: 'deny' (default, fail-closed) or 'allow' (fail-open). */
  fallback?: 'deny' | 'allow';
}

export interface CodexConfigPaths {
  codexHome: string;
  configPath: string;
}

export interface CodexConfigAnalysis {
  ownedBlockCount: number;
  bridgeHookCounts: Record<CodexHookEventName, number>;
  hasDuplicateBridgeHooks: boolean;
  hooksFeatureEnabled: boolean;
  hooksFeatureDisabled: boolean;
  referencesCli: boolean;
  hasOrbiterMcpServer: boolean;
  backendMode: CodexConfigBackendMode;
  captureDir?: string;
  mockDecision?: CodexApprovalStatus;
}

const CODEX_CONFIG_BEGIN = '# BEGIN orbiter-dev-codex';
const CODEX_CONFIG_END = '# END orbiter-dev-codex';
const ORBITER_HOOK_MARKER = 'orbiter-dev-codex';
const ORBITER_MCP_SERVER_MARKER = '[mcp_servers.orbiter_dev]';
const HOOK_EVENTS: CodexHookEventName[] = [
  'SessionStart',
  'SubagentStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'SubagentStop',
  'Stop',
];

export function getCodexConfigPaths(codexHome = process.env.CODEX_HOME): CodexConfigPaths {
  const resolvedHome = path.resolve(codexHome || path.join(os.homedir(), '.codex'));
  return {
    codexHome: resolvedHome,
    configPath: path.join(resolvedHome, 'config.toml'),
  };
}

export function patchCodexConfig(
  input: string,
  context: CodexConfigContext,
  options: CodexConfigPatchOptions = {},
): string {
  const withoutOwnedBlock = removeOwnedBlock(input);
  const withHooksFeature = ensureHooksFeatureEnabled(withoutOwnedBlock);
  const ownedBlock = buildOwnedBlock(context, options);
  return normalizeTrailingNewline(`${withHooksFeature.trimEnd()}\n\n${ownedBlock}`);
}

export function unpatchCodexConfig(input: string): string {
  const withoutOwnedBlock = removeOwnedBlock(input);
  const withoutManagedFeatureLine = withoutOwnedBlock
    .replace(/^\s*hooks\s*=\s*true\s*#\s*orbiter-dev-codex\s*$/gm, '')
    .replace(/^\s*\[features]\s*\n(?=\s*(?:\[|$))/gm, '')
    .replace(/\n{3,}/g, '\n\n');
  return normalizeTrailingNewline(withoutManagedFeatureLine.trim());
}

export function extractOwnedCodexConfigBlock(input: string): string {
  const pattern = new RegExp(
    `${escapeRegExp(CODEX_CONFIG_BEGIN)}[\\s\\S]*?${escapeRegExp(CODEX_CONFIG_END)}`,
    'g',
  );
  return input.match(pattern)?.at(-1) || '';
}

export function analyzeCodexConfig(input: string, cliPath?: string): CodexConfigAnalysis {
  const hookCommands = extractHookCommands(input);
  const bridgeHookCounts = HOOK_EVENTS.reduce<Record<CodexHookEventName, number>>((counts, event) => {
    counts[event] = countBridgeHooksForEvent(input, event);
    return counts;
  }, {
    SessionStart: 0,
    SubagentStart: 0,
    UserPromptSubmit: 0,
    PreToolUse: 0,
    PermissionRequest: 0,
    PostToolUse: 0,
    PreCompact: 0,
    PostCompact: 0,
    SubagentStop: 0,
    Stop: 0,
  });

  return {
    ownedBlockCount: countMatches(input, new RegExp(escapeRegExp(CODEX_CONFIG_BEGIN), 'g')),
    bridgeHookCounts,
    hasDuplicateBridgeHooks: Object.values(bridgeHookCounts).some((count) => count > 1),
    hooksFeatureEnabled: /^\s*hooks\s*=\s*true(?:\s|#|$)/m.test(input),
    hooksFeatureDisabled: /^\s*hooks\s*=\s*false(?:\s|#|$)/m.test(input),
    referencesCli: cliPath ? input.includes(cliPath) : input.includes('codex-hook'),
    hasOrbiterMcpServer: input.includes(ORBITER_MCP_SERVER_MARKER),
    backendMode: backendModeFromHookCommands(hookCommands),
    captureDir: captureDirFromHookCommands(hookCommands),
    mockDecision: mockDecisionFromHookCommands(hookCommands),
  };
}

export function codexConfigHookEventsForProfile(profile: CodexConfigHookProfile): CodexHookEventName[] {
  if (profile === 'minimal') return ['PermissionRequest'];
  if (profile === 'guarded') return ['PermissionRequest', 'PreToolUse'];
  return [
    'SessionStart',
    'SubagentStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PermissionRequest',
    'PostToolUse',
    'PreCompact',
    'PostCompact',
    'SubagentStop',
    'Stop',
  ];
}

function buildOwnedBlock(context: CodexConfigContext, options: CodexConfigPatchOptions): string {
  const adapter = effectiveAdapter(options);
  const mockDecision = options.mockDecision || (options.offlineCapture && adapter === 'mock' ? 'rejected' : undefined);
  const hookProfile = options.hookProfile || 'minimal';
  const timeout = options.approvalTimeoutSeconds || 300;
  const command = buildHookCommand(context.cliPath, {
    adapter,
    mockDecision,
    serverUrl: options.serverUrl,
    timeout,
    captureDir: options.captureDir,
    criticalMode: options.criticalMode,
    fallback: options.fallback,
  });
  const lines = [
    CODEX_CONFIG_BEGIN,
    '# Managed by Orbiter Dev. Use `orbiter-mcp codex uninstall` to remove.',
    '[mcp_servers.orbiter_dev]',
    'command = "node"',
    `args = ["${tomlBasicString(context.cliPath)}"]`,
    'startup_timeout_sec = 20',
    'tool_timeout_sec = 300',
    'enabled = true',
    'default_tools_approval_mode = "prompt"',
    '',
    `[mcp_servers.orbiter_dev.${'env'}]`,
    'ORBITER_CREDENTIAL_PROFILE = "codex"',
    'ORBITER_IDE_NAME = "Codex"',
    ...(options.serverUrl ? [`ORBITER_SERVER_URL = "${tomlBasicString(options.serverUrl)}"`] : []),
    '',
  ];

  for (const event of codexConfigHookEventsForProfile(hookProfile)) {
    lines.push(...buildHookLines(event, command, timeout));
  }

  lines.push(CODEX_CONFIG_END);
  return lines.join('\n');
}

function buildHookLines(event: CodexHookEventName, command: string, timeout: number): string[] {
  const lines = [
    `[[hooks.${event}]]`,
    ...matcherLines(event),
    '',
    `[[hooks.${event}.hooks]]`,
    'type = "command"',
    `command = '${tomlLiteralString(command)}'`,
    `timeout = ${timeout}`,
    `statusMessage = "${tomlBasicString(statusMessageForEvent(event))}"`,
    '',
  ];
  return lines;
}

function buildHookCommand(
  cliPath: string,
  options: {
    adapter: CodexConfigAdapter;
    mockDecision?: CodexApprovalStatus;
    serverUrl?: string;
    timeout: number;
    captureDir?: string;
    criticalMode?: 'ask' | 'deny';
    fallback?: 'deny' | 'allow';
  },
): string {
  const parts = [
    'node',
    shellDoubleQuote(cliPath),
    'codex-hook',
    '--adapter',
    options.adapter,
    '--timeout',
    String(options.timeout),
  ];
  if (options.captureDir) parts.push('--capture-dir', shellDoubleQuote(options.captureDir));
  if (options.mockDecision) parts.push('--mock-decision', options.mockDecision);
  if (options.serverUrl) parts.push('--server-url', shellDoubleQuote(options.serverUrl));
  // Only non-default choices are written, keeping existing configs byte-stable.
  if (options.criticalMode === 'deny') parts.push('--critical', 'deny');
  if (options.fallback === 'allow') parts.push('--fallback', 'allow');
  return parts.join(' ');
}

function effectiveAdapter(options: CodexConfigPatchOptions): CodexConfigAdapter {
  if (options.offlineCapture && (!options.adapter || options.adapter === 'http')) return 'mock';
  return options.adapter || 'http';
}

function matcherLines(event: CodexHookEventName): string[] {
  if (event === 'SessionStart') return ['matcher = "startup|resume|clear|compact"'];
  if (event === 'PreCompact' || event === 'PostCompact') return ['matcher = "manual|auto"'];
  if (event === 'UserPromptSubmit' || event === 'Stop') return [];
  return ['matcher = ".*"'];
}

function statusMessageForEvent(event: CodexHookEventName): string {
  if (event === 'PermissionRequest') return 'Requesting Orbiter mobile approval';
  if (event === 'PreToolUse') return 'Checking Orbiter risk policy';
  if (event === 'PostToolUse') return 'Reporting Codex tool result to Orbiter';
  if (event === 'SessionStart') return 'Starting Orbiter Codex session';
  if (event === 'SubagentStart') return 'Starting Orbiter Codex subagent session';
  if (event === 'PreCompact') return 'Capturing Orbiter Codex pre-compact metadata';
  if (event === 'PostCompact') return 'Capturing Orbiter Codex post-compact metadata';
  if (event === 'SubagentStop') return 'Closing Orbiter Codex subagent session';
  if (event === 'UserPromptSubmit') return 'Capturing Orbiter Codex prompt metadata';
  return 'Closing Orbiter Codex session';
}

function ensureHooksFeatureEnabled(input: string): string {
  const featureMatch = input.match(/^\s*\[features]\s*$/m);
  if (featureMatch?.index !== undefined) {
    const afterHeaderIndex = featureMatch.index + featureMatch[0].length;
    const nextSectionMatch = input.slice(afterHeaderIndex).match(/\n\s*\[/);
    const sectionEnd = nextSectionMatch?.index === undefined
      ? input.length
      : afterHeaderIndex + nextSectionMatch.index;
    const beforeSection = input.slice(0, afterHeaderIndex);
    const featureBody = input.slice(afterHeaderIndex, sectionEnd);
    const afterSection = input.slice(sectionEnd);

    if (/^\s*hooks\s*=/m.test(featureBody)) {
      return `${beforeSection}${featureBody.replace(/^(\s*)hooks\s*=.*$/m, '$1hooks = true # orbiter-dev-codex')}${afterSection}`;
    }
    return `${beforeSection}\nhooks = true # orbiter-dev-codex${featureBody}${afterSection}`;
  }
  return `[features]\nhooks = true # orbiter-dev-codex\n\n${input.trimStart()}`;
}

function removeOwnedBlock(input: string): string {
  const pattern = new RegExp(
    `${escapeRegExp(CODEX_CONFIG_BEGIN)}[\\s\\S]*?${escapeRegExp(CODEX_CONFIG_END)}\\s*`,
    'g',
  );
  return input.replace(pattern, '').trimEnd();
}

function countBridgeHooksForEvent(input: string, event: CodexHookEventName): number {
  const sectionPattern = new RegExp(
    `${escapeRegExp(`[[hooks.${event}.hooks]]`)}[\\s\\S]*?(?=\\n\\[\\[hooks\\.|\\n# END|\\n# BEGIN|$)`,
    'g',
  );
  const sections = input.match(sectionPattern) || [];
  return sections.filter((section) => section.includes(ORBITER_HOOK_MARKER) || section.includes('codex-hook')).length;
}

function extractHookCommands(input: string): string[] {
  const commands: string[] = [];
  for (const match of input.matchAll(/command\s*=\s*'((?:[^']|'')*)'/g)) {
    commands.push(match[1].replace(/''/g, "'"));
  }
  return commands.filter((command) => command.includes('codex-hook'));
}

function backendModeFromHookCommands(commands: string[]): CodexConfigBackendMode {
  if (!commands.length) return 'missing';
  if (commands.some((command) => command.includes('--capture-dir'))) return 'offline-capture';
  const adapters = commands.map((command) => command.match(/--adapter\s+(\S+)/)?.[1]).filter(Boolean);
  if (adapters.some((adapter) => adapter === 'http')) return 'live-http';
  if (adapters.length && adapters.every((adapter) => adapter === 'mock')) return 'mock';
  if (adapters.length && adapters.every((adapter) => adapter === 'file')) return 'file';
  if (!adapters.length) return 'live-http';
  return 'unknown';
}

function captureDirFromHookCommands(commands: string[]): string | undefined {
  const command = commands.find((item) => item.includes('--capture-dir'));
  if (!command) return undefined;
  const match = command.match(/--capture-dir\s+("[^"]+"|\S+)/);
  return match?.[1]?.replace(/^"|"$/g, '').replace(/\\"/g, '"');
}

function mockDecisionFromHookCommands(commands: string[]): CodexApprovalStatus | undefined {
  const decisions = commands
    .map((command) => command.match(/--mock-decision\s+(\S+)/)?.[1])
    .filter((value): value is CodexApprovalStatus => (
      value === 'approved'
      || value === 'rejected'
      || value === 'timeout'
      || value === 'pending'
    ));
  if (!decisions.length) return undefined;
  const unique = new Set(decisions);
  return unique.size === 1 ? decisions[0] : undefined;
}

function tomlLiteralString(value: string): string {
  return value.replace(/'/g, "''");
}

function tomlBasicString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function shellDoubleQuote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function countMatches(input: string, pattern: RegExp): number {
  return input.match(pattern)?.length || 0;
}

function normalizeTrailingNewline(input: string): string {
  return input.length > 0 ? `${input}\n` : '';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
