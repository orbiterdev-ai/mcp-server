import fs from 'fs';
import os from 'os';
import path from 'path';
import type {
  AntigravityApprovalAdapterName,
  AntigravityApprovalFallback,
  AntigravityApprovalStatus,
  AntigravityHookProfile,
} from './types.js';

export type AntigravityConfigScope = 'workspace' | 'global';
export type AntigravityConfigBackendMode = 'missing' | 'offline-capture' | 'live-http' | 'mock' | 'file' | 'unknown';

export interface AntigravityConfigContext {
  cliPath: string;
}

export interface AntigravityConfigPatchOptions {
  adapter?: AntigravityApprovalAdapterName;
  mockDecision?: AntigravityApprovalStatus;
  serverUrl?: string;
  approvalTimeoutSeconds?: number;
  profile?: AntigravityHookProfile;
  fallback?: AntigravityApprovalFallback;
  offlineCapture?: boolean;
  captureDir?: string;
  /** 'ask' (default): critical routes to the phone; 'deny': local hard-deny. */
  criticalMode?: 'ask' | 'deny';
}

export interface AntigravityConfigPaths {
  scope: AntigravityConfigScope;
  root: string;
  configPath: string;
}

export interface AntigravityConfigAnalysis {
  ownedHookPresent: boolean;
  ownedHookEnabled: boolean;
  preToolUseHookCount: number;
  postToolUseHookCount: number;
  preInvocationHookCount: number;
  postInvocationHookCount: number;
  stopHookCount: number;
  matcher: string;
  referencesCli: boolean;
  timeoutSeconds?: number;
  backendMode: AntigravityConfigBackendMode;
  captureDir?: string;
  mockDecision?: AntigravityApprovalStatus;
}

export const ANTIGRAVITY_HOOK_NAME = 'orbiter-approval-gate';
export const ANTIGRAVITY_HOOK_RUNNER_FILENAME = 'orbiter-antigravity-hook.cjs';

interface AntigravityHookCommand {
  type?: 'command';
  command: string;
  timeout?: number;
}

interface AntigravityToolMatcher {
  matcher: string;
  hooks: AntigravityHookCommand[];
}

interface AntigravityOwnedHook {
  enabled?: boolean;
  PreToolUse?: AntigravityToolMatcher[];
  PostToolUse?: AntigravityToolMatcher[];
  PreInvocation?: AntigravityHookCommand[];
  PostInvocation?: AntigravityHookCommand[];
  Stop?: AntigravityHookCommand[];
}

type AntigravityHooksConfig = Record<string, unknown>;

export function getAntigravityHooksPaths(
  scope: AntigravityConfigScope = 'workspace',
  workspace = process.cwd(),
  home = os.homedir(),
): AntigravityConfigPaths {
  if (scope === 'global') {
    const root = path.join(home, '.gemini', 'config');
    return { scope, root, configPath: path.join(root, 'hooks.json') };
  }
  const root = path.resolve(workspace, '.agents');
  return { scope, root, configPath: path.join(root, 'hooks.json') };
}

export function patchAntigravityHooksConfig(
  input: string,
  context: AntigravityConfigContext,
  options: AntigravityConfigPatchOptions = {},
): string {
  const config = parseHooksConfig(input);
  config[ANTIGRAVITY_HOOK_NAME] = buildOwnedHook(context, options);
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function unpatchAntigravityHooksConfig(input: string): string {
  const config = parseHooksConfig(input);
  delete config[ANTIGRAVITY_HOOK_NAME];
  return Object.keys(config).length ? `${JSON.stringify(config, null, 2)}\n` : '';
}

export function analyzeAntigravityHooksConfig(input: string, cliPath?: string): AntigravityConfigAnalysis {
  let config: AntigravityHooksConfig = {};
  try {
    config = parseHooksConfig(input);
  } catch {
    return {
      ownedHookPresent: false,
      ownedHookEnabled: false,
      preToolUseHookCount: 0,
      postToolUseHookCount: 0,
      preInvocationHookCount: 0,
      postInvocationHookCount: 0,
      stopHookCount: 0,
      matcher: '',
      referencesCli: false,
      backendMode: 'missing',
    };
  }

  const owned = asOwnedHook(config[ANTIGRAVITY_HOOK_NAME]);
  const commands = collectCommands(owned);
  const preToolUseHookCount = owned?.PreToolUse?.flatMap((entry) => entry.hooks || []).length || 0;
  const postToolUseHookCount = owned?.PostToolUse?.flatMap((entry) => entry.hooks || []).length || 0;
  const preInvocationHookCount = owned?.PreInvocation?.length || 0;
  const postInvocationHookCount = owned?.PostInvocation?.length || 0;
  const stopHookCount = owned?.Stop?.length || 0;
  return {
    ownedHookPresent: Boolean(owned),
    ownedHookEnabled: owned ? owned.enabled !== false : false,
    preToolUseHookCount,
    postToolUseHookCount,
    preInvocationHookCount,
    postInvocationHookCount,
    stopHookCount,
    matcher: owned?.PreToolUse?.[0]?.matcher || '',
    referencesCli: cliPath
      ? commands.some((command) => command.includes(cliPath) || command.includes(ANTIGRAVITY_HOOK_RUNNER_FILENAME))
      : commands.some((command) => command.includes('antigravity-hook') || command.includes(ANTIGRAVITY_HOOK_RUNNER_FILENAME)),
    timeoutSeconds: owned?.PreToolUse?.[0]?.hooks?.[0]?.timeout,
    backendMode: backendModeFromHookCommands(commands),
    captureDir: captureDirFromHookCommands(commands),
    mockDecision: mockDecisionFromHookCommands(commands),
  };
}

export function readAntigravityHooksConfig(paths: AntigravityConfigPaths): string {
  if (!fs.existsSync(paths.configPath)) return '';
  return fs.readFileSync(paths.configPath, 'utf8');
}

export function writeAntigravityHooksConfig(paths: AntigravityConfigPaths, content: string, backupSuffix: string): void {
  fs.mkdirSync(paths.root, { recursive: true });
  if (fs.existsSync(paths.configPath)) {
    fs.copyFileSync(paths.configPath, `${paths.configPath}.${backupSuffix}.bak`);
  }
  if (content) {
    fs.writeFileSync(paths.configPath, content, 'utf8');
  } else if (fs.existsSync(paths.configPath)) {
    fs.unlinkSync(paths.configPath);
  }
}

export function getAntigravityHookRunnerPath(paths: AntigravityConfigPaths): string {
  return path.join(paths.root, ANTIGRAVITY_HOOK_RUNNER_FILENAME);
}

export function buildAntigravityHookRunnerScript(cliPath: string): string {
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
  console.error('Orbiter Antigravity hook runner exited with signal ' + result.signal);
}
process.exit(1);
`;
}

export function writeAntigravityHookRunner(paths: AntigravityConfigPaths, cliPath: string): boolean {
  fs.mkdirSync(paths.root, { recursive: true });
  const runnerPath = getAntigravityHookRunnerPath(paths);
  const content = buildAntigravityHookRunnerScript(cliPath);
  const before = fs.existsSync(runnerPath) ? fs.readFileSync(runnerPath, 'utf8') : '';
  if (before === content) return false;
  fs.writeFileSync(runnerPath, content, 'utf8');
  return true;
}

export function removeAntigravityHookRunner(paths: AntigravityConfigPaths): boolean {
  const runnerPath = getAntigravityHookRunnerPath(paths);
  if (!fs.existsSync(runnerPath)) return false;
  fs.unlinkSync(runnerPath);
  return true;
}

function buildOwnedHook(context: AntigravityConfigContext, options: AntigravityConfigPatchOptions): AntigravityOwnedHook {
  const adapter = effectiveAdapter(options);
  const mockDecision = options.mockDecision || (options.offlineCapture && adapter === 'mock' ? 'rejected' : undefined);
  const profile = options.profile || 'blocking';
  const fallback = options.fallback || 'deny';
  const timeout = options.approvalTimeoutSeconds || 300;
  return {
    enabled: true,
    PreToolUse: [
      {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            command: buildHookCommand(context.cliPath, 'PreToolUse', {
              adapter,
              profile,
              fallback,
              timeout,
              mockDecision,
              serverUrl: options.serverUrl,
          criticalMode: options.criticalMode,
              captureDir: options.captureDir,
            }),
            timeout,
          },
        ],
      },
    ],
    PostToolUse: [
      {
        matcher: '*',
        hooks: [
          {
            type: 'command',
            command: buildHookCommand(context.cliPath, 'PostToolUse', {
              adapter,
              profile,
              fallback,
              timeout: 30,
              mockDecision,
              serverUrl: options.serverUrl,
          criticalMode: options.criticalMode,
              captureDir: options.captureDir,
            }),
            timeout: 30,
          },
        ],
      },
    ],
    PreInvocation: [
      {
        type: 'command',
        command: buildHookCommand(context.cliPath, 'PreInvocation', {
          adapter,
          profile,
          fallback,
          timeout: 10,
          mockDecision,
          serverUrl: options.serverUrl,
          criticalMode: options.criticalMode,
          captureDir: options.captureDir,
        }),
        timeout: 10,
      },
    ],
    PostInvocation: [
      {
        type: 'command',
        command: buildHookCommand(context.cliPath, 'PostInvocation', {
          adapter,
          profile,
          fallback,
          timeout: 10,
          mockDecision,
          serverUrl: options.serverUrl,
          criticalMode: options.criticalMode,
          captureDir: options.captureDir,
        }),
        timeout: 10,
      },
    ],
    Stop: [
      {
        type: 'command',
        command: buildHookCommand(context.cliPath, 'Stop', {
          adapter,
          profile,
          fallback,
          timeout: 30,
          mockDecision,
          serverUrl: options.serverUrl,
          criticalMode: options.criticalMode,
          captureDir: options.captureDir,
        }),
        timeout: 30,
      },
    ],
  };
}

function buildHookCommand(
  cliPath: string,
  eventName: string,
  options: {
    adapter: AntigravityApprovalAdapterName;
    profile: AntigravityHookProfile;
    fallback: AntigravityApprovalFallback;
    timeout: number;
    mockDecision?: AntigravityApprovalStatus;
    serverUrl?: string;
    captureDir?: string;
    criticalMode?: 'ask' | 'deny';
  },
): string {
  const parts = [
    'node',
    ANTIGRAVITY_HOOK_RUNNER_FILENAME,
    'antigravity-hook',
    eventName,
    '--profile',
    options.profile,
    '--adapter',
    options.adapter,
    '--timeout',
    String(options.timeout),
    '--fallback',
    options.fallback,
  ];
  if (options.captureDir) parts.push('--capture-dir', hookCommandToken(options.captureDir));
  if (options.mockDecision) parts.push('--mock-decision', options.mockDecision);
  if (options.serverUrl) parts.push('--server-url', hookCommandToken(options.serverUrl));
  if (options.criticalMode === 'deny') parts.push('--critical', 'deny');
  return parts.join(' ');
}

function effectiveAdapter(options: AntigravityConfigPatchOptions): AntigravityApprovalAdapterName {
  if (options.offlineCapture && (!options.adapter || options.adapter === 'http')) return 'mock';
  return options.adapter || 'http';
}

function parseHooksConfig(input: string): AntigravityHooksConfig {
  if (!input.trim()) return {};
  const parsed = JSON.parse(input) as unknown;
  if (!isRecord(parsed)) throw new Error('Antigravity hooks config must be a JSON object');
  return parsed;
}

function asOwnedHook(value: unknown): AntigravityOwnedHook | undefined {
  if (!isRecord(value)) return undefined;
  return value as unknown as AntigravityOwnedHook;
}

function collectCommands(hook: AntigravityOwnedHook | undefined): string[] {
  if (!hook) return [];
  const commands: string[] = [];
  for (const entry of hook.PreToolUse || []) {
    for (const command of entry.hooks || []) commands.push(command.command);
  }
  for (const entry of hook.PostToolUse || []) {
    for (const command of entry.hooks || []) commands.push(command.command);
  }
  for (const command of hook.PreInvocation || []) commands.push(command.command);
  for (const command of hook.PostInvocation || []) commands.push(command.command);
  for (const command of hook.Stop || []) commands.push(command.command);
  return commands;
}

function backendModeFromHookCommands(commands: string[]): AntigravityConfigBackendMode {
  const hookCommands = commands.filter((command) => command.includes('antigravity-hook'));
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
  const command = commands.find((item) => item.includes('antigravity-hook') && item.includes('--capture-dir'));
  return command?.match(/--capture-dir\s+(\S+)/)?.[1];
}

function mockDecisionFromHookCommands(commands: string[]): AntigravityApprovalStatus | undefined {
  const decisions = commands
    .filter((command) => command.includes('antigravity-hook'))
    .map((command) => command.match(/--mock-decision\s+(\S+)/)?.[1])
    .filter((value): value is AntigravityApprovalStatus => (
      value === 'approved'
      || value === 'rejected'
      || value === 'timeout'
      || value === 'pending'
    ));
  if (!decisions.length) return undefined;
  const unique = new Set(decisions);
  return unique.size === 1 ? decisions[0] : undefined;
}

function hookCommandToken(value: string): string {
  if (/[\s"]/u.test(value)) {
    throw new Error(`Antigravity hook command value cannot contain whitespace or quotes: ${value}`);
  }
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
