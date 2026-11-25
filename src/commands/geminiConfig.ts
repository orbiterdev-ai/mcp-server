import fs from 'fs';
import path from 'path';
import type {
  GeminiApprovalAdapterName,
  GeminiApprovalStatus,
  GeminiConfigScope,
  GeminiHookProfile,
} from '../gemini/types.js';
import {
  analyzeGeminiSettings,
  geminiRunnerCommandPath,
  getGeminiConfigPaths,
  patchGeminiSettings,
  readGeminiSettings,
  removeGeminiHookRunner,
  unpatchGeminiSettings,
  writeGeminiHookRunner,
  writeGeminiSettings,
  type GeminiConfigAnalysis,
  type GeminiConfigPatchOptions,
} from '../gemini/config.js';
import { handleGeminiHook } from '../gemini/hooks.js';

interface GeminiConfigCommandOptions extends GeminiConfigPatchOptions {
  scope?: GeminiConfigScope;
  workspace?: string;
  dryRun?: boolean;
  checkBackend?: boolean;
}

interface DoctorCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export async function handleGeminiConfigCommand(args: string[]): Promise<void> {
  const subcommand = args[0] && !args[0].startsWith('--') ? args[0] : 'doctor';
  const options = parseGeminiConfigArgs(subcommand === args[0] ? args.slice(1) : args);

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

  throw new Error(`Unknown gemini subcommand: ${subcommand}`);
}

function runSetup(options: GeminiConfigCommandOptions): Record<string, unknown> {
  const workspaceRoot = path.resolve(options.workspace || process.cwd());
  const paths = getGeminiConfigPaths(options.scope || 'workspace', workspaceRoot);
  const cliPath = currentCliPath();
  const before = readGeminiSettings(paths);
  const patched = patchGeminiSettings(before, {
    cliPath,
    runnerCommandPath: geminiRunnerCommandPath(paths),
  }, options);
  const settingsChanged = patched !== before;
  const runnerChanged = !fs.existsSync(paths.runnerPath) || !runnerReferencesCli(fs.readFileSync(paths.runnerPath, 'utf8'), cliPath);
  const changed = settingsChanged || runnerChanged;

  if (!options.dryRun) {
    if (settingsChanged) writeGeminiSettings(paths, patched, 'orbiter-dev-gemini');
    writeGeminiHookRunner(paths, cliPath);
  }

  return {
    success: true,
    action: 'setup',
    dryRun: Boolean(options.dryRun),
    changed,
    settingsChanged,
    runnerChanged,
    paths,
    analysis: analyzeGeminiSettings(patched, cliPath),
  };
}

function runUninstall(options: GeminiConfigCommandOptions): Record<string, unknown> {
  const workspaceRoot = path.resolve(options.workspace || process.cwd());
  const paths = getGeminiConfigPaths(options.scope || 'workspace', workspaceRoot);
  const before = readGeminiSettings(paths);
  const next = unpatchGeminiSettings(before);
  const settingsChanged = next !== before;
  const runnerRemoved = !options.dryRun && removeGeminiHookRunner(paths);
  const changed = settingsChanged || runnerRemoved || (options.dryRun && fs.existsSync(paths.runnerPath));

  if (!options.dryRun && settingsChanged) {
    writeGeminiSettings(paths, next, 'orbiter-dev-gemini-uninstall');
  }

  return {
    success: true,
    action: 'uninstall',
    dryRun: Boolean(options.dryRun),
    changed,
    settingsChanged,
    runnerRemoved,
    paths,
    analysis: analyzeGeminiSettings(next, currentCliPath()),
  };
}

async function runDoctor(options: GeminiConfigCommandOptions): Promise<Record<string, unknown>> {
  const workspaceRoot = path.resolve(options.workspace || process.cwd());
  const paths = getGeminiConfigPaths(options.scope || 'workspace', workspaceRoot);
  const cliPath = currentCliPath();
  const settings = readGeminiSettings(paths);
  let settingsParses = true;
  let analysis = analyzeGeminiSettings(settings, cliPath);
  try {
    if (settings.trim()) JSON.parse(settings) as unknown;
  } catch {
    settingsParses = false;
    analysis = analyzeGeminiSettings('', cliPath);
  }

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
      name: 'hook_runner_present',
      ok: fs.existsSync(paths.runnerPath),
      detail: paths.runnerPath,
    },
    {
      name: 'hook_runner_references_cli',
      ok: fs.existsSync(paths.runnerPath) && runnerReferencesCli(fs.readFileSync(paths.runnerPath, 'utf8'), cliPath),
      detail: cliPath,
    },
    {
      name: 'beforetool_hook_present',
      ok: analysis.ownedBeforeToolHookCount === 1,
      detail: String(analysis.ownedBeforeToolHookCount),
    },
    {
      name: 'no_duplicate_orbiter_hooks',
      ok: !analysis.hasDuplicateOwnedHooks,
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
      name: 'backend_mode',
      ok: analysis.backendMode !== 'unknown',
      detail: analysis.backendMode,
    },
  ];

  checks.push(await dryRunBeforeToolCheck(options, analysis));

  if (options.checkBackend) {
    checks.push(await backendHealthCheck(options.serverUrl));
  }

  return {
    success: checks.every((check) => check.ok),
    action: 'doctor',
    paths,
    analysis,
    checks,
  };
}

async function dryRunBeforeToolCheck(
  options: GeminiConfigCommandOptions,
  analysis: GeminiConfigAnalysis,
): Promise<DoctorCheck> {
  const mockDecision = options.mockDecision || analysis.mockDecision || 'approved';
  try {
    const result = await handleGeminiHook({
      session_id: 'orbiter-gemini-doctor-session',
      cwd: process.cwd(),
      hook_event_name: 'BeforeTool',
      timestamp: new Date().toISOString(),
      tool_name: 'run_shell_command',
      tool_input: {
        command: ['npm', 'publish', '--dry-run'].join(' '),
      },
    }, {
      eventName: 'BeforeTool',
      adapter: 'mock',
      mockDecision,
      timeoutSeconds: options.approvalTimeoutSeconds,
      serverUrl: options.serverUrl,
    });

    return {
      name: 'beforetool_mock_roundtrip',
      ok: JSON.stringify(result.output).length > 0,
      detail: JSON.stringify({
        mockDecision,
        output: result.output,
      }),
    };
  } catch (error) {
    return {
      name: 'beforetool_mock_roundtrip',
      ok: false,
      detail: String(error),
    };
  }
}

async function backendHealthCheck(serverUrl: string | undefined): Promise<DoctorCheck> {
  if (!serverUrl) {
    return {
      name: 'backend_health',
      ok: false,
      detail: 'Pass --server-url to check backend health.',
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

function parseGeminiConfigArgs(args: string[]): GeminiConfigCommandOptions {
  const options: GeminiConfigCommandOptions = {
    scope: 'workspace',
    profile: 'minimal',
    includeMcpServer: true,
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
    } else if (arg === '--adapter') {
      const adapter = parseAdapter(next);
      if (adapter) options.adapter = adapter;
      i++;
    } else if (arg === '--mock-decision') {
      const decision = parseMockDecision(next);
      if (decision) options.mockDecision = decision;
      i++;
    } else if (arg === '--server-url') {
      options.serverUrl = next;
      i++;
    } else if (arg === '--approval-timeout' || arg === '--timeout') {
      const timeout = Number(next || '300');
      if (Number.isFinite(timeout) && timeout > 0) options.approvalTimeoutSeconds = timeout;
      i++;
    } else if (arg === '--profile') {
      const profile = parseProfile(next);
      if (profile) options.profile = profile;
      i++;
    } else if (arg === '--critical') {
      if (next === 'ask' || next === 'deny') options.criticalMode = next;
      i++;
    } else if (arg === '--fallback') {
      if (next === 'deny' || next === 'allow') options.fallback = next;
      i++;
    } else if (arg === '--offline-capture') {
      options.offlineCapture = true;
    } else if (arg === '--capture-dir') {
      options.captureDir = next;
      i++;
    } else if (arg === '--without-mcp-server') {
      options.includeMcpServer = false;
    }
  }

  applyOfflineCaptureConfigDefaults(options);
  return options;
}

function applyOfflineCaptureConfigDefaults(options: GeminiConfigCommandOptions): void {
  if (!options.offlineCapture) return;
  options.captureDir ||= '.tmp_hook_captures';
  if (!options.adapter || options.adapter === 'http') options.adapter = 'mock';
  if (options.adapter === 'mock' && !options.mockDecision) options.mockDecision = 'rejected';
  delete options.serverUrl;
  options.checkBackend = false;
}

function currentCliPath(): string {
  const candidate = process.argv[1] || path.join(process.cwd(), 'dist', 'index.js');
  return path.resolve(candidate);
}

function nodeMajorVersion(): number {
  return Number(process.version.replace(/^v/, '').split('.')[0] || '0');
}

function runnerReferencesCli(content: string, cliPath: string): boolean {
  const escapedCliPath = JSON.stringify(cliPath).slice(1, -1);
  return content.includes(cliPath) || content.includes(escapedCliPath);
}

function parseScope(value: string | undefined): GeminiConfigScope | undefined {
  if (value === 'workspace' || value === 'global') return value;
  return undefined;
}

function parseAdapter(value: string | undefined): GeminiApprovalAdapterName | undefined {
  if (value === 'mock' || value === 'file' || value === 'http') return value;
  return undefined;
}

function parseMockDecision(value: string | undefined): GeminiApprovalStatus | undefined {
  if (value === 'approved' || value === 'rejected' || value === 'timeout' || value === 'pending') return value;
  return undefined;
}

function parseProfile(value: string | undefined): GeminiHookProfile | undefined {
  if (value === 'minimal' || value === 'guarded' || value === 'full') return value;
  return undefined;
}
