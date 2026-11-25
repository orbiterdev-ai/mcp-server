import fs from 'fs';
import os from 'os';
import path from 'path';
import { getCredentialPath, loadCredentials } from '../auth/credentials.js';
import { MCP_PACKAGE_VERSION } from '../version.js';

type ClaudeConfigScope = 'project' | 'global' | 'both';
type JsonRecord = Record<string, unknown>;

interface ClaudeConfigCommandOptions {
  scope: ClaudeConfigScope;
  workspace?: string;
  claudeHome?: string;
  serverUrl?: string;
  dryRun?: boolean;
  checkBackend?: boolean;
}

interface ClaudeConfigPaths {
  scope: Exclude<ClaudeConfigScope, 'both'>;
  root: string;
  settingsPath: string;
}

interface ClaudeConfigAnalysis {
  hasPermissionRequestHook: boolean;
  permissionRequestHookCount: number;
  hasDuplicateOrbiterHooks: boolean;
  hasOrbiterMcpServer: boolean;
  referencesCli: boolean;
  backendMode: 'missing' | 'live-http' | 'local-http' | 'unknown';
  serverUrl?: string;
}

interface DoctorCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

const CLAUDE_MCP_SERVER_NAME = 'orbiter-dev';
const CLAUDE_HOOK_MARKER = 'orbiter-approval-gate';
const DEFAULT_SERVER_URL = 'https://api.orbiterdev.ai';
const CLAUDE_HOOK_RUNNER_FILENAME = 'orbiter-claude-hook.cjs';

/**
 * Stable-edge runner (same pattern as the antigravity/gemini adapters). The trusted
 * `.claude/settings.json` hook command points at this runner by its stable absolute path in
 * the user's `.claude` directory - which does NOT move when the npm package is updated. The
 * volatile package path (`dist/index.js`) lives only INSIDE the runner, which is regenerated
 * on every `setup`. So an `npm update` changes the runner's body but never the trusted command
 * string, avoiding both the stale-path failure and Claude Code's hook-changed re-review prompt.
 * (The MCP server entry keeps the direct path, matching the gemini adapter - server config
 * changes don't trigger a security re-review and self-heal on the next setup.)
 */
function getClaudeHookRunnerPath(paths: ClaudeConfigPaths): string {
  return path.join(paths.root, CLAUDE_HOOK_RUNNER_FILENAME);
}

function buildClaudeHookRunnerScript(cliPath: string): string {
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
  console.error('Orbiter Claude hook runner exited with signal ' + result.signal);
}
process.exit(1);
`;
}

function writeClaudeHookRunner(paths: ClaudeConfigPaths, cliPath: string): boolean {
  fs.mkdirSync(paths.root, { recursive: true });
  const runnerPath = getClaudeHookRunnerPath(paths);
  const content = buildClaudeHookRunnerScript(cliPath);
  const before = fs.existsSync(runnerPath) ? fs.readFileSync(runnerPath, 'utf8') : '';
  if (before === content) return false;
  fs.writeFileSync(runnerPath, content, 'utf8');
  return true;
}

function removeClaudeHookRunner(paths: ClaudeConfigPaths): boolean {
  const runnerPath = getClaudeHookRunnerPath(paths);
  if (!fs.existsSync(runnerPath)) return false;
  fs.unlinkSync(runnerPath);
  return true;
}

export async function handleClaudeConfigCommand(args: string[]): Promise<void> {
  const subcommand = args[0] && !args[0].startsWith('--') ? args[0] : 'doctor';
  const options = parseClaudeConfigArgs(subcommand === args[0] ? args.slice(1) : args);

  if (subcommand === 'setup') {
    const result = runSetup(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (subcommand === 'uninstall') {
    const result = runUninstall(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (subcommand === 'doctor') {
    const result = await runDoctor(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.success ? 0 : 1;
    return;
  }

  throw new Error(`Unknown claude subcommand: ${subcommand}`);
}

function runSetup(options: ClaudeConfigCommandOptions): Record<string, unknown> {
  const cliPath = currentCliPath();
  const targets = targetPaths(options);
  const results = targets.map((paths) => {
    const runnerPath = getClaudeHookRunnerPath(paths);
    const before = readSettings(paths);
    const patched = patchClaudeSettings(before, cliPath, runnerPath, effectiveServerUrl(options));
    const changed = patched !== before;

    if (!options.dryRun) {
      if (changed) writeSettings(paths, patched, 'orbiter-dev-claude');
      // Always (re)write the runner so its embedded package path tracks the current install,
      // without disturbing the stable command string in settings.json.
      writeClaudeHookRunner(paths, cliPath);
    }

    return {
      scope: paths.scope,
      changed,
      paths,
      runnerPath,
      analysis: analyzeClaudeSettings(patched, cliPath),
    };
  });

  return {
    success: true,
    action: 'setup',
    dryRun: Boolean(options.dryRun),
    changed: results.some((result) => result.changed),
    targets: results,
    analysis: results[0]?.analysis ?? emptyAnalysis(),
  };
}

function runUninstall(options: ClaudeConfigCommandOptions): Record<string, unknown> {
  const cliPath = currentCliPath();
  const results = targetPaths(options).map((paths) => {
    const before = readSettings(paths);
    const next = unpatchClaudeSettings(before);
    const changed = next !== before;

    if (!options.dryRun) {
      if (changed) writeSettings(paths, next, 'orbiter-dev-claude-uninstall');
      removeClaudeHookRunner(paths);
    }

    return {
      scope: paths.scope,
      changed,
      paths,
      analysis: analyzeClaudeSettings(next, cliPath),
    };
  });

  return {
    success: true,
    action: 'uninstall',
    dryRun: Boolean(options.dryRun),
    changed: results.some((result) => result.changed),
    targets: results,
    analysis: results[0]?.analysis ?? emptyAnalysis(),
  };
}

async function runDoctor(options: ClaudeConfigCommandOptions): Promise<Record<string, unknown>> {
  const cliPath = currentCliPath();
  const paths = targetPaths(options)[0];
  const settings = readSettings(paths);
  let settingsParses = true;
  let analysis = analyzeClaudeSettings(settings, cliPath);

  try {
    if (settings.trim()) JSON.parse(settings) as unknown;
  } catch {
    settingsParses = false;
    analysis = emptyAnalysis();
  }

  const credentials = loadCredentials();
  const checks: DoctorCheck[] = [
    {
      name: 'node_version',
      ok: nodeMajorVersion() >= 18,
      detail: process.version,
    },
    {
      name: 'settings_exists',
      ok: fs.existsSync(paths.settingsPath),
      detail: paths.settingsPath,
    },
    {
      name: 'settings_json_parses',
      ok: settingsParses,
    },
    {
      name: 'permission_request_hook_present',
      ok: analysis.permissionRequestHookCount === 1,
      detail: String(analysis.permissionRequestHookCount),
    },
    {
      name: 'no_duplicate_orbiter_hooks',
      ok: !analysis.hasDuplicateOrbiterHooks,
    },
    {
      name: 'orbiter_mcp_server_present',
      ok: analysis.hasOrbiterMcpServer,
    },
    {
      name: 'config_references_cli',
      ok: analysis.referencesCli,
      detail: cliPath,
    },
    {
      name: 'hook_runner_present',
      ok: fs.existsSync(getClaudeHookRunnerPath(paths)),
      detail: getClaudeHookRunnerPath(paths),
    },
    {
      name: 'backend_mode',
      ok: analysis.backendMode === 'live-http',
      detail: analysis.backendMode,
    },
    {
      name: 'credentials_present',
      ok: Boolean(credentials?.api_key),
      detail: getCredentialPath(),
    },
    {
      name: 'credentials_backend_url_present',
      ok: Boolean(credentials?.backend_url),
      detail: credentials?.backend_url,
    },
    {
      name: 'package_version',
      ok: MCP_PACKAGE_VERSION.length > 0,
      detail: MCP_PACKAGE_VERSION,
    },
    {
      name: 'claude_scope_checked',
      ok: paths.scope === 'project' || paths.scope === 'global',
      detail: paths.scope,
    },
    {
      name: 'session_approval_cache_note',
      ok: true,
      detail: 'Claude may cache permission decisions per session; start a new Claude session after setup changes.',
    },
    strayLocalSettingsCheck(paths),
  ];

  if (options.checkBackend) {
    checks.push(await backendHealthCheck(options.serverUrl || analysis.serverUrl || credentials?.backend_url));
  }

  return {
    success: checks.every((check) => check.ok),
    action: 'doctor',
    paths,
    analysis,
    credentials: {
      present: Boolean(credentials?.api_key),
      backendUrl: credentials?.backend_url,
      path: getCredentialPath(),
    },
    sessionApprovalCache: {
      behavior: 'new Claude sessions may be required after hook changes',
      userAction: 'After setup, close the current Claude Code session and open a fresh one if approvals do not appear.',
    },
    checks,
  };
}

/**
 * Claude Code ALSO merges hooks from `.claude/settings.local.json`, which setup/uninstall
 * do not own. Legacy or hand-added Orbiter hooks there run IN ADDITION to the managed
 * hook - the classic symptoms are double approval cards and phantom lifecycle pushes
 * (e.g. "Session Ended" the moment a new chat starts). Doctor surfaces them so users can
 * remove the stale block instead of debugging ghost behavior.
 */
function strayLocalSettingsCheck(paths: ClaudeConfigPaths): DoctorCheck {
  const localPath = path.join(paths.root, 'settings.local.json');
  if (!fs.existsSync(localPath)) {
    return { name: 'no_stray_hooks_in_settings_local', ok: true, detail: `${localPath} not present` };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(localPath, 'utf8')) as JsonRecord;
    const hooks = isRecord(parsed.hooks) ? parsed.hooks : {};
    const strayEvents = Object.entries(hooks)
      .filter(([, entries]) => JSON.stringify(entries).toLowerCase().includes('orbiter'))
      .map(([event]) => event);
    return {
      name: 'no_stray_hooks_in_settings_local',
      ok: strayEvents.length === 0,
      detail: strayEvents.length
        ? `Orbiter hooks found in ${localPath} (${strayEvents.join(', ')}); they run in addition to the managed hook - remove them to avoid double gating and phantom notifications.`
        : localPath,
    };
  } catch {
    return { name: 'no_stray_hooks_in_settings_local', ok: true, detail: `${localPath} unreadable; skipped` };
  }
}

function patchClaudeSettings(input: string, cliPath: string, runnerPath: string, serverUrl: string): string {
  const settings = parseSettings(input);
  const hooks = isRecord(settings.hooks) ? { ...settings.hooks } : {};
  const permissionRequest = Array.isArray(hooks.PermissionRequest) ? hooks.PermissionRequest as unknown[] : [];
  hooks.PermissionRequest = [
    ...permissionRequest.filter((entry) => !hookEntryIsOwned(entry)),
    buildPermissionRequestHook(runnerPath, serverUrl),
  ];
  settings.hooks = hooks;

  const mcpServers = isRecord(settings.mcpServers) ? { ...settings.mcpServers } : {};
  mcpServers[CLAUDE_MCP_SERVER_NAME] = {
    command: 'node',
    args: [cliPath],
    env: {
      ORBITER_CREDENTIAL_PROFILE: 'claude-code',
      ORBITER_IDE_NAME: 'Claude Code',
      ORBITER_SERVER_URL: serverUrl,
    },
  };
  settings.mcpServers = mcpServers;

  return `${JSON.stringify(settings, null, 2)}\n`;
}

function unpatchClaudeSettings(input: string): string {
  const settings = parseSettings(input);
  const hooks = isRecord(settings.hooks) ? { ...settings.hooks } : {};
  const permissionRequest = Array.isArray(hooks.PermissionRequest) ? hooks.PermissionRequest as unknown[] : [];
  const withoutOwned = permissionRequest.filter((entry) => !hookEntryIsOwned(entry));
  if (withoutOwned.length) hooks.PermissionRequest = withoutOwned;
  else delete hooks.PermissionRequest;
  if (Object.keys(hooks).length) settings.hooks = hooks;
  else delete settings.hooks;

  if (isRecord(settings.mcpServers)) {
    const mcpServers = { ...settings.mcpServers };
    delete mcpServers[CLAUDE_MCP_SERVER_NAME];
    if (Object.keys(mcpServers).length) settings.mcpServers = mcpServers;
    else delete settings.mcpServers;
  }

  return Object.keys(settings).length ? `${JSON.stringify(settings, null, 2)}\n` : '';
}

function analyzeClaudeSettings(input: string, cliPath?: string): ClaudeConfigAnalysis {
  let settings: JsonRecord;
  try {
    settings = parseSettings(input);
  } catch {
    return emptyAnalysis();
  }

  const permissionRequestEntries = permissionRequestEntriesFrom(settings);
  const ownedHookCount = permissionRequestEntries.filter((entry) => hookEntryIsOwned(entry)).length;
  const hasOrbiterMcpServer = isRecord(settings.mcpServers) && isRecord(settings.mcpServers[CLAUDE_MCP_SERVER_NAME]);
  const allConfig = JSON.stringify(settings);
  const commands = collectHookCommands(settings);
  const serverUrl = extractServerUrl(settings);

  return {
    hasPermissionRequestHook: ownedHookCount >= 1,
    permissionRequestHookCount: ownedHookCount,
    hasDuplicateOrbiterHooks: ownedHookCount > 1,
    hasOrbiterMcpServer,
    referencesCli: cliPath
      ? configReferencesCli(allConfig, cliPath) || commands.some((command) => command.includes(CLAUDE_HOOK_RUNNER_FILENAME))
      : commands.some((command) => command.includes('permission-check') || command.includes(CLAUDE_HOOK_RUNNER_FILENAME)),
    backendMode: backendModeFromConfig(allConfig, serverUrl),
    serverUrl,
  };
}

function buildPermissionRequestHook(runnerPath: string, serverUrl: string): JsonRecord {
  return {
    matcher: '*',
    hooks: [
      {
        name: `${CLAUDE_HOOK_MARKER}-permission-check`,
        type: 'command',
        // Points at the stable .claude runner, NOT the volatile package path (stable-edge).
        command: `node ${shellToken(runnerPath)} permission-check`,
        env: {
          ORBITER_SERVER_URL: serverUrl,
          ORBITER_CREDENTIAL_PROFILE: 'claude-code',
          ORBITER_IDE_NAME: 'Claude Code',
        },
        timeout: 300000,
      },
    ],
  };
}

function targetPaths(options: ClaudeConfigCommandOptions): ClaudeConfigPaths[] {
  const workspace = path.resolve(options.workspace || process.cwd());
  const home = options.claudeHome ? path.resolve(options.claudeHome) : os.homedir();
  if (options.scope === 'both') {
    return [
      claudePaths('project', workspace, home),
      claudePaths('global', workspace, home),
    ];
  }
  return [claudePaths(options.scope, workspace, home)];
}

function claudePaths(scope: Exclude<ClaudeConfigScope, 'both'>, workspace: string, home: string): ClaudeConfigPaths {
  const root = scope === 'project' ? path.join(workspace, '.claude') : path.join(home, '.claude');
  return {
    scope,
    root,
    settingsPath: path.join(root, 'settings.json'),
  };
}

function readSettings(paths: ClaudeConfigPaths): string {
  if (!fs.existsSync(paths.settingsPath)) return '';
  return fs.readFileSync(paths.settingsPath, 'utf8');
}

function writeSettings(paths: ClaudeConfigPaths, content: string, backupSuffix: string): void {
  fs.mkdirSync(paths.root, { recursive: true });
  if (fs.existsSync(paths.settingsPath)) {
    fs.copyFileSync(paths.settingsPath, `${paths.settingsPath}.${backupSuffix}.bak`);
  }
  if (content) fs.writeFileSync(paths.settingsPath, content, 'utf8');
  else if (fs.existsSync(paths.settingsPath)) fs.unlinkSync(paths.settingsPath);
}

async function backendHealthCheck(serverUrl: string | undefined): Promise<DoctorCheck> {
  if (!serverUrl) {
    return {
      name: 'backend_health',
      ok: false,
      detail: 'Pass --server-url or pair once so credentials include backend_url.',
    };
  }

  try {
    const response = await fetch(new URL('/api/v1/health', serverUrl));
    return {
      name: 'backend_health',
      ok: response.ok,
      detail: `${response.status} ${response.statusText}`,
    };
  } catch (error) {
    return {
      name: 'backend_health',
      ok: false,
      detail: String(error),
    };
  }
}

function parseClaudeConfigArgs(args: string[]): ClaudeConfigCommandOptions {
  const options: ClaudeConfigCommandOptions = {
    scope: 'project',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--check-backend') {
      options.checkBackend = true;
    } else if (arg === '--scope') {
      const scope = parseScope(next);
      if (scope) options.scope = scope;
      i++;
    } else if (arg === '--workspace') {
      options.workspace = next;
      i++;
    } else if (arg === '--claude-home') {
      options.claudeHome = next;
      i++;
    } else if (arg === '--server-url') {
      options.serverUrl = next;
      i++;
    }
  }

  return options;
}

function effectiveServerUrl(options: ClaudeConfigCommandOptions): string {
  return (options.serverUrl || loadCredentials()?.backend_url || DEFAULT_SERVER_URL).replace(/\/+$/, '');
}

function backendModeFromConfig(config: string, serverUrl: string | undefined): ClaudeConfigAnalysis['backendMode'] {
  if (!config.includes('permission-check')) return 'missing';
  if ((serverUrl || config).includes('127.0.0.1') || (serverUrl || config).includes('localhost')) return 'local-http';
  if (serverUrl?.startsWith('https://') || config.includes('https://')) return 'live-http';
  return 'unknown';
}

function extractServerUrl(settings: JsonRecord): string | undefined {
  for (const value of collectEnvValues(settings, 'ORBITER_SERVER_URL')) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function collectEnvValues(value: unknown, key: string): unknown[] {
  const values: unknown[] = [];
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (!isRecord(item)) return;
    if (isRecord(item.env) && Object.hasOwn(item.env, key)) values.push(item.env[key]);
    for (const child of Object.values(item)) visit(child);
  };
  visit(value);
  return values;
}

function collectHookCommands(settings: JsonRecord): string[] {
  const commands: string[] = [];
  for (const entry of permissionRequestEntriesFrom(settings)) {
    if (!isRecord(entry) || !Array.isArray(entry.hooks)) continue;
    for (const hook of entry.hooks) {
      if (isRecord(hook) && typeof hook.command === 'string') commands.push(hook.command);
    }
  }
  return commands;
}

function permissionRequestEntriesFrom(settings: JsonRecord): unknown[] {
  const hooks = isRecord(settings.hooks) ? settings.hooks : {};
  return Array.isArray(hooks.PermissionRequest) ? hooks.PermissionRequest as unknown[] : [];
}

function hookEntryIsOwned(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.hooks)) return false;
  return value.hooks.some((hook) => {
    if (!isRecord(hook)) return false;
    const name = typeof hook.name === 'string' ? hook.name : '';
    const command = typeof hook.command === 'string' ? hook.command : '';
    return name.startsWith(CLAUDE_HOOK_MARKER) || (command.includes('permission-check') && command.includes('orbiter'));
  });
}

function parseSettings(input: string): JsonRecord {
  if (!input.trim()) return {};
  const parsed = JSON.parse(input) as unknown;
  if (!isRecord(parsed)) throw new Error('Claude settings must be a JSON object');
  return parsed;
}

function emptyAnalysis(): ClaudeConfigAnalysis {
  return {
    hasPermissionRequestHook: false,
    permissionRequestHookCount: 0,
    hasDuplicateOrbiterHooks: false,
    hasOrbiterMcpServer: false,
    referencesCli: false,
    backendMode: 'missing',
  };
}

function currentCliPath(): string {
  const candidate = process.argv[1] || path.join(process.cwd(), 'dist', 'index.js');
  return path.resolve(candidate);
}

function configReferencesCli(content: string, cliPath: string): boolean {
  const escapedCliPath = JSON.stringify(cliPath).slice(1, -1);
  return content.includes(cliPath) || content.includes(escapedCliPath);
}

function nodeMajorVersion(): number {
  return Number(process.version.replace(/^v/, '').split('.')[0] || '0');
}

function parseScope(value: string | undefined): ClaudeConfigScope | undefined {
  if (value === 'project' || value === 'global' || value === 'both') return value;
  return undefined;
}

function shellToken(value: string): string {
  if (!/[\s"]/u.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
