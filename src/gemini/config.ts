import fs from 'fs';
import os from 'os';
import path from 'path';
import type {
  GeminiApprovalAdapterName,
  GeminiApprovalStatus,
  GeminiConfigScope,
  GeminiHookEventName,
  GeminiHookProfile,
} from './types.js';

export interface GeminiConfigContext {
  cliPath: string;
  runnerCommandPath: string;
}

export interface GeminiConfigPatchOptions {
  adapter?: GeminiApprovalAdapterName;
  mockDecision?: GeminiApprovalStatus;
  serverUrl?: string;
  approvalTimeoutSeconds?: number;
  profile?: GeminiHookProfile;
  includeMcpServer?: boolean;
  offlineCapture?: boolean;
  captureDir?: string;
  /** 'ask' (default): critical routes to the phone; 'deny': local hard-deny. */
  criticalMode?: 'ask' | 'deny';
  /** Incomplete-decision policy: 'deny' (default, fail-closed) or 'allow' (fail-open). */
  fallback?: 'deny' | 'allow';
}

export type GeminiConfigBackendMode = 'missing' | 'offline-capture' | 'live-http' | 'mock' | 'file' | 'unknown';

export interface GeminiConfigPaths {
  scope: GeminiConfigScope;
  root: string;
  settingsPath: string;
  hooksRoot: string;
  runnerPath: string;
}

export interface GeminiConfigAnalysis {
  hasOwnedHooks: boolean;
  ownedHookCounts: Record<GeminiHookEventName, number>;
  ownedBeforeToolHookCount: number;
  ownedAfterToolHookCount: number;
  hasDuplicateOwnedHooks: boolean;
  hasOrbiterMcpServer: boolean;
  referencesCli: boolean;
  backendMode: GeminiConfigBackendMode;
  captureDir?: string;
  mockDecision?: GeminiApprovalStatus;
}

type JsonRecord = Record<string, unknown>;

export const GEMINI_HOOK_RUNNER_FILENAME = 'orbiter-gemini-hook.cjs';
export const GEMINI_HOOK_MARKER = 'orbiter-approval-gate';
export const GEMINI_MCP_SERVER_NAME = 'orbiter-dev';

const GEMINI_HOOK_EVENTS: GeminiHookEventName[] = [
  'SessionStart',
  'SessionEnd',
  'BeforeAgent',
  'AfterAgent',
  'BeforeModel',
  'AfterModel',
  'BeforeToolSelection',
  'BeforeTool',
  'AfterTool',
  'PreCompress',
  'Notification',
];

export function getGeminiConfigPaths(
  scope: GeminiConfigScope = 'workspace',
  workspace = process.cwd(),
  home = os.homedir(),
): GeminiConfigPaths {
  const root = scope === 'global'
    ? path.join(home, '.gemini')
    : path.resolve(workspace, '.gemini');
  const hooksRoot = path.join(root, 'hooks');
  return {
    scope,
    root,
    settingsPath: path.join(root, 'settings.json'),
    hooksRoot,
    runnerPath: path.join(hooksRoot, GEMINI_HOOK_RUNNER_FILENAME),
  };
}

export function geminiRunnerCommandPath(paths: GeminiConfigPaths): string {
  if (paths.scope === 'workspace') return path.posix.join('.gemini', 'hooks', GEMINI_HOOK_RUNNER_FILENAME);
  return paths.runnerPath;
}

export function readGeminiSettings(paths: GeminiConfigPaths): string {
  if (!fs.existsSync(paths.settingsPath)) return '';
  return fs.readFileSync(paths.settingsPath, 'utf8');
}

export function writeGeminiSettings(paths: GeminiConfigPaths, content: string, backupSuffix: string): void {
  fs.mkdirSync(paths.root, { recursive: true });
  if (fs.existsSync(paths.settingsPath)) {
    fs.copyFileSync(paths.settingsPath, `${paths.settingsPath}.${backupSuffix}.bak`);
  }
  if (content) {
    fs.writeFileSync(paths.settingsPath, content, 'utf8');
  } else if (fs.existsSync(paths.settingsPath)) {
    fs.unlinkSync(paths.settingsPath);
  }
}

export function patchGeminiSettings(
  input: string,
  context: GeminiConfigContext,
  options: GeminiConfigPatchOptions = {},
): string {
  const settings = parseSettings(input);
  const hooks = isRecord(settings.hooks) ? { ...settings.hooks } : {};
  for (const event of GEMINI_HOOK_EVENTS) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] as unknown[] : [];
    const withoutOwned = existing.filter((entry) => !hookDefinitionIsOwned(entry));
    const owned = buildHookDefinition(event, context, options);
    if (owned) hooks[event] = [...withoutOwned, owned];
    else if (withoutOwned.length) hooks[event] = withoutOwned;
    else delete hooks[event];
  }
  settings.hooks = hooks;

  if (options.includeMcpServer !== false) {
    const mcpServers = isRecord(settings.mcpServers) ? { ...settings.mcpServers } : {};
    mcpServers[GEMINI_MCP_SERVER_NAME] = buildMcpServer(context, options);
    settings.mcpServers = mcpServers;
  }

  return `${JSON.stringify(settings, null, 2)}\n`;
}

export function unpatchGeminiSettings(input: string): string {
  const settings = parseSettings(input);
  const hooks = isRecord(settings.hooks) ? { ...settings.hooks } : {};
  for (const event of GEMINI_HOOK_EVENTS) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] as unknown[] : [];
    const withoutOwned = existing.filter((entry) => !hookDefinitionIsOwned(entry));
    if (withoutOwned.length) hooks[event] = withoutOwned;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length) settings.hooks = hooks;
  else delete settings.hooks;

  if (isRecord(settings.mcpServers)) {
    const mcpServers = { ...settings.mcpServers };
    delete mcpServers[GEMINI_MCP_SERVER_NAME];
    if (Object.keys(mcpServers).length) settings.mcpServers = mcpServers;
    else delete settings.mcpServers;
  }

  return Object.keys(settings).length ? `${JSON.stringify(settings, null, 2)}\n` : '';
}

export function analyzeGeminiSettings(input: string, cliPath?: string): GeminiConfigAnalysis {
  let settings: JsonRecord = {};
  try {
    settings = parseSettings(input);
  } catch {
    return emptyAnalysis();
  }

  const hooks = isRecord(settings.hooks) ? settings.hooks : {};
  const ownedHookCounts = GEMINI_HOOK_EVENTS.reduce<Record<GeminiHookEventName, number>>((counts, event) => {
    const entries = Array.isArray(hooks[event]) ? hooks[event] as unknown[] : [];
    counts[event] = entries.filter((entry) => hookDefinitionIsOwned(entry)).length;
    return counts;
  }, {
    SessionStart: 0,
    SessionEnd: 0,
    BeforeAgent: 0,
    AfterAgent: 0,
    BeforeModel: 0,
    AfterModel: 0,
    BeforeToolSelection: 0,
    BeforeTool: 0,
    AfterTool: 0,
    PreCompress: 0,
    Notification: 0,
  });
  const commands = collectHookCommands(settings);
  const hasOrbiterMcpServer = isRecord(settings.mcpServers) && isRecord(settings.mcpServers[GEMINI_MCP_SERVER_NAME]);
  const referencesCli = cliPath
    ? commands.some((command) => command.includes(cliPath) || command.includes(GEMINI_HOOK_RUNNER_FILENAME))
    : commands.some((command) => command.includes('gemini-hook') || command.includes(GEMINI_HOOK_RUNNER_FILENAME));

  return {
    hasOwnedHooks: Object.values(ownedHookCounts).some((count) => count > 0),
    ownedHookCounts,
    ownedBeforeToolHookCount: ownedHookCounts.BeforeTool,
    ownedAfterToolHookCount: ownedHookCounts.AfterTool,
    hasDuplicateOwnedHooks: Object.values(ownedHookCounts).some((count) => count > 1),
    hasOrbiterMcpServer,
    referencesCli,
    backendMode: backendModeFromHookCommands(commands),
    captureDir: captureDirFromHookCommands(commands),
    mockDecision: mockDecisionFromHookCommands(commands),
  };
}

export function buildGeminiHookRunnerScript(cliPath: string): string {
  const resolvedCliPath = path.resolve(cliPath);
  return `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');

const cliPath = ${JSON.stringify(resolvedCliPath)};
const result = spawnSync(process.execPath, [cliPath, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
});

if (result.error) {
  console.error(String(result.error));
  process.exit(1);
}

if (typeof result.status === 'number') {
  process.exit(result.status);
}

if (result.signal) {
  console.error('Orbiter Gemini hook runner exited with signal ' + result.signal);
}
process.exit(1);
`;
}

export function writeGeminiHookRunner(paths: GeminiConfigPaths, cliPath: string): boolean {
  fs.mkdirSync(paths.hooksRoot, { recursive: true });
  const content = buildGeminiHookRunnerScript(cliPath);
  const before = fs.existsSync(paths.runnerPath) ? fs.readFileSync(paths.runnerPath, 'utf8') : '';
  if (before === content) return false;
  fs.writeFileSync(paths.runnerPath, content, 'utf8');
  return true;
}

export function removeGeminiHookRunner(paths: GeminiConfigPaths): boolean {
  if (!fs.existsSync(paths.runnerPath)) return false;
  fs.unlinkSync(paths.runnerPath);
  return true;
}

export function geminiConfigHookEventsForProfile(profile: GeminiHookProfile): GeminiHookEventName[] {
  if (profile === 'minimal') return ['BeforeTool'];
  if (profile === 'guarded') return ['SessionStart', 'BeforeTool', 'AfterTool', 'Notification'];
  return ['SessionStart', 'BeforeAgent', 'BeforeTool', 'AfterTool', 'AfterAgent', 'Notification', 'PreCompress', 'SessionEnd'];
}

function buildHookDefinition(
  event: GeminiHookEventName,
  context: GeminiConfigContext,
  options: GeminiConfigPatchOptions,
): JsonRecord | undefined {
  const profile = options.profile || 'minimal';
  if (!geminiConfigHookEventsForProfile(profile).includes(event)) return undefined;
  const timeoutSeconds = timeoutSecondsForEvent(event, options.approvalTimeoutSeconds || 300);
  return {
    matcher: matcherForEvent(event),
    sequential: true,
    hooks: [
      {
        name: `${GEMINI_HOOK_MARKER}-${event}`,
        type: 'command',
        command: buildHookCommand(context.runnerCommandPath, event, {
          adapter: effectiveAdapter(options),
          mockDecision: options.mockDecision || (options.offlineCapture && effectiveAdapter(options) === 'mock' ? 'rejected' : undefined),
          serverUrl: options.serverUrl,
          criticalMode: options.criticalMode,
          fallback: options.fallback,
          timeoutSeconds,
          captureDir: options.captureDir,
        }),
        timeout: timeoutSeconds * 1000,
        description: descriptionForEvent(event),
      },
    ],
  };
}

function buildHookCommand(
  runnerCommandPath: string,
  event: GeminiHookEventName,
  options: {
    adapter: GeminiApprovalAdapterName;
    mockDecision?: GeminiApprovalStatus;
    serverUrl?: string;
    timeoutSeconds: number;
    captureDir?: string;
    criticalMode?: 'ask' | 'deny';
    fallback?: 'deny' | 'allow';
  },
): string {
  const parts = [
    'node',
    shellToken(runnerCommandPath),
    'gemini-hook',
    event,
    '--adapter',
    options.adapter,
    '--timeout',
    String(options.timeoutSeconds),
  ];
  if (options.captureDir) parts.push('--capture-dir', shellToken(options.captureDir));
  if (options.mockDecision) parts.push('--mock-decision', options.mockDecision);
  if (options.serverUrl) parts.push('--server-url', shellToken(options.serverUrl));
  if (options.criticalMode === 'deny') parts.push('--critical', 'deny');
  if (options.fallback === 'allow') parts.push('--fallback', 'allow');
  return parts.join(' ');
}

function effectiveAdapter(options: GeminiConfigPatchOptions): GeminiApprovalAdapterName {
  if (options.offlineCapture && (!options.adapter || options.adapter === 'http')) return 'mock';
  return options.adapter || 'http';
}

function buildMcpServer(context: GeminiConfigContext, options: GeminiConfigPatchOptions): JsonRecord {
  const env: JsonRecord = {
    ORBITER_CREDENTIAL_PROFILE: 'gemini-cli',
    ORBITER_IDE_NAME: 'Gemini CLI',
  };
  if (options.serverUrl) env.ORBITER_SERVER_URL = options.serverUrl;
  return {
    command: 'node',
    args: [context.cliPath],
    env,
  };
}

function matcherForEvent(event: GeminiHookEventName): string {
  if (event === 'SessionStart') return 'startup';
  if (event === 'SessionEnd') return 'exit';
  if (event === 'PreCompress') return 'auto';
  return '*';
}

function timeoutSecondsForEvent(event: GeminiHookEventName, approvalTimeoutSeconds: number): number {
  if (event === 'BeforeTool') return approvalTimeoutSeconds;
  if (event === 'AfterTool' || event === 'Notification') return 30;
  return 10;
}

function descriptionForEvent(event: GeminiHookEventName): string {
  if (event === 'BeforeTool') return 'Route risky Gemini CLI tool calls through Orbiter mobile approval.';
  if (event === 'AfterTool') return 'Observe Gemini CLI tool results for Orbiter telemetry.';
  if (event === 'Notification') return 'Forward Gemini CLI notifications to Orbiter.';
  return `Observe Gemini CLI ${event} lifecycle event.`;
}

function hookDefinitionIsOwned(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const hooks = Array.isArray(value.hooks) ? value.hooks : [];
  return hooks.some((hook) => {
    if (!isRecord(hook)) return false;
    const name = typeof hook.name === 'string' ? hook.name : '';
    const command = typeof hook.command === 'string' ? hook.command : '';
    return name.startsWith(GEMINI_HOOK_MARKER) || command.includes(GEMINI_HOOK_RUNNER_FILENAME) || command.includes('gemini-hook');
  });
}

function collectHookCommands(settings: JsonRecord): string[] {
  const commands: string[] = [];
  const hooks = isRecord(settings.hooks) ? settings.hooks : {};
  for (const value of Object.values(hooks)) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (!isRecord(entry) || !Array.isArray(entry.hooks)) continue;
      for (const hook of entry.hooks) {
        if (isRecord(hook) && typeof hook.command === 'string') commands.push(hook.command);
      }
    }
  }
  return commands;
}

function backendModeFromHookCommands(commands: string[]): GeminiConfigBackendMode {
  const hookCommands = commands.filter((command) => command.includes('gemini-hook'));
  if (!hookCommands.length) return 'missing';
  if (hookCommands.some((command) => command.includes('--capture-dir'))) return 'offline-capture';
  const adapters = hookCommands.map((command) => command.match(/--adapter\s+(\S+)/)?.[1]).filter(Boolean);
  if (adapters.some((adapter) => adapter === 'http')) return 'live-http';
  if (adapters.length && adapters.every((adapter) => adapter === 'mock')) return 'mock';
  if (adapters.length && adapters.every((adapter) => adapter === 'file')) return 'file';
  if (!adapters.length) return 'live-http';
  return 'unknown';
}

function captureDirFromHookCommands(commands: string[]): string | undefined {
  const command = commands.find((item) => item.includes('gemini-hook') && item.includes('--capture-dir'));
  const quoted = command?.match(/--capture-dir\s+"([^"]+)"/)?.[1];
  if (quoted) return quoted.replace(/\\"/g, '"');
  return command?.match(/--capture-dir\s+(\S+)/)?.[1];
}

function mockDecisionFromHookCommands(commands: string[]): GeminiApprovalStatus | undefined {
  const decisions = commands
    .filter((command) => command.includes('gemini-hook'))
    .map((command) => command.match(/--mock-decision\s+(\S+)/)?.[1])
    .filter((value): value is GeminiApprovalStatus => (
      value === 'approved'
      || value === 'rejected'
      || value === 'timeout'
      || value === 'pending'
    ));
  if (!decisions.length) return undefined;
  const unique = new Set(decisions);
  return unique.size === 1 ? decisions[0] : undefined;
}

function parseSettings(input: string): JsonRecord {
  if (!input.trim()) return {};
  const parsed = JSON.parse(input) as unknown;
  if (!isRecord(parsed)) throw new Error('Gemini settings must be a JSON object');
  return parsed;
}

function emptyAnalysis(): GeminiConfigAnalysis {
  return {
    hasOwnedHooks: false,
    ownedHookCounts: {
      SessionStart: 0,
      SessionEnd: 0,
      BeforeAgent: 0,
      AfterAgent: 0,
      BeforeModel: 0,
      AfterModel: 0,
      BeforeToolSelection: 0,
      BeforeTool: 0,
      AfterTool: 0,
      PreCompress: 0,
      Notification: 0,
    },
    ownedBeforeToolHookCount: 0,
    ownedAfterToolHookCount: 0,
    hasDuplicateOwnedHooks: false,
    hasOrbiterMcpServer: false,
    referencesCli: false,
    backendMode: 'missing',
  };
}

function shellToken(value: string): string {
  if (!/[\s"]/u.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
