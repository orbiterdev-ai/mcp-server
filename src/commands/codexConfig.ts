import fs from 'fs';
import path from 'path';
import type { CodexApprovalStatus } from '../codex/types.js';
import {
  analyzeCodexConfig,
  extractOwnedCodexConfigBlock,
  getCodexConfigPaths,
  patchCodexConfig,
  unpatchCodexConfig,
  type CodexConfigAdapter,
  type CodexConfigAnalysis,
  type CodexConfigHookProfile,
  type CodexConfigPaths,
  type CodexConfigPatchOptions,
} from '../codex/config.js';
import { handleCodexHook } from '../codex/hooks.js';

interface CodexConfigCommandOptions extends CodexConfigPatchOptions {
  codexHome?: string;
  dryRun?: boolean;
  checkBackend?: boolean;
}

interface DoctorCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export async function handleCodexConfigCommand(args: string[]): Promise<void> {
  const subcommand = args[0] && !args[0].startsWith('--') ? args[0] : 'doctor';
  const options = parseCodexConfigArgs(subcommand === args[0] ? args.slice(1) : args);

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

  throw new Error(`Unknown codex subcommand: ${subcommand}`);
}

function runSetup(options: CodexConfigCommandOptions): Record<string, unknown> {
  const paths = getCodexConfigPaths(options.codexHome);
  const before = readConfig(paths);
  const cliPath = currentCliPath();
  const patched = patchCodexConfig(before, { cliPath }, options);
  const changed = patched !== before;

  if (!options.dryRun && changed) {
    fs.mkdirSync(paths.codexHome, { recursive: true });
    if (fs.existsSync(paths.configPath)) {
      fs.copyFileSync(paths.configPath, `${paths.configPath}.orbiter-dev-codex.bak`);
    }
    fs.writeFileSync(paths.configPath, patched, 'utf8');
  }

  return {
    success: true,
    action: 'setup',
    dryRun: Boolean(options.dryRun),
    changed,
    paths,
    analysis: analyzeCodexConfig(patched, cliPath),
    managedBlockPreview: options.dryRun ? extractOwnedCodexConfigBlock(patched) : undefined,
  };
}

function runUninstall(options: CodexConfigCommandOptions): Record<string, unknown> {
  const paths = getCodexConfigPaths(options.codexHome);
  const before = readConfig(paths);
  const next = unpatchCodexConfig(before);
  const changed = next !== before;

  if (!options.dryRun && changed) {
    fs.mkdirSync(paths.codexHome, { recursive: true });
    if (fs.existsSync(paths.configPath)) {
      fs.copyFileSync(paths.configPath, `${paths.configPath}.orbiter-dev-codex-uninstall.bak`);
    }
    fs.writeFileSync(paths.configPath, next, 'utf8');
  }

  return {
    success: true,
    action: 'uninstall',
    dryRun: Boolean(options.dryRun),
    changed,
    paths,
    analysis: analyzeCodexConfig(next, currentCliPath()),
    managedBlockPreview: options.dryRun ? extractOwnedCodexConfigBlock(before) : undefined,
  };
}

async function runDoctor(options: CodexConfigCommandOptions): Promise<Record<string, unknown>> {
  const paths = getCodexConfigPaths(options.codexHome);
  const config = readConfig(paths);
  const cliPath = currentCliPath();
  const analysis = analyzeCodexConfig(config, cliPath);
  const checks: DoctorCheck[] = [
    {
      name: 'node_version',
      ok: nodeMajorVersion() >= 18,
      detail: process.version,
    },
    {
      name: 'codex_home_exists',
      ok: fs.existsSync(paths.codexHome),
      detail: paths.codexHome,
    },
    {
      name: 'config_exists',
      ok: fs.existsSync(paths.configPath),
      detail: paths.configPath,
    },
    {
      name: 'hooks_feature_enabled',
      ok: analysis.hooksFeatureEnabled && !analysis.hooksFeatureDisabled,
      detail: analysis.hooksFeatureDisabled ? 'hooks=false found' : undefined,
    },
    {
      name: 'owned_block_present',
      ok: analysis.ownedBlockCount === 1,
      detail: String(analysis.ownedBlockCount),
    },
    {
      name: 'permission_request_hook_present',
      ok: analysis.bridgeHookCounts.PermissionRequest === 1,
      detail: String(analysis.bridgeHookCounts.PermissionRequest),
    },
    {
      name: 'no_duplicate_orbiter_hooks',
      ok: !analysis.hasDuplicateBridgeHooks,
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

  checks.push(await dryRunPermissionHookCheck(options, analysis));

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

async function dryRunPermissionHookCheck(
  options: CodexConfigCommandOptions,
  analysis: CodexConfigAnalysis,
): Promise<DoctorCheck> {
  const mockDecision = options.mockDecision || analysis.mockDecision || 'approved';
  try {
    const result = await handleCodexHook({
      session_id: 'orbiter-codex-doctor-session',
      turn_id: 'orbiter-codex-doctor-turn',
      tool_use_id: 'orbiter-codex-doctor-tool',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      cwd: process.cwd(),
      model: 'codex-doctor',
      tool_input: {
        command: ['npm', 'publish', '--dry-run'].join(' '),
      },
    }, {
      adapter: 'mock',
      mockDecision,
      timeoutSeconds: options.approvalTimeoutSeconds,
      serverUrl: options.serverUrl,
    });

    return {
      name: 'permission_request_mock_roundtrip',
      ok: JSON.stringify(result.output).includes('PermissionRequest'),
      detail: JSON.stringify({
        mockDecision,
        output: result.output,
      }),
    };
  } catch (error) {
    return {
      name: 'permission_request_mock_roundtrip',
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

function parseCodexConfigArgs(args: string[]): CodexConfigCommandOptions {
  const options: CodexConfigCommandOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--codex-home') {
      options.codexHome = next;
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
    } else if (arg === '--hook-profile') {
      const profile = parseHookProfile(next);
      if (profile) options.hookProfile = profile;
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
    } else if (arg === '--check-backend') {
      options.checkBackend = true;
    }
  }

  applyOfflineCaptureConfigDefaults(options);
  return options;
}

function applyOfflineCaptureConfigDefaults(options: CodexConfigCommandOptions): void {
  if (!options.offlineCapture) return;
  options.captureDir ||= '.tmp_hook_captures';
  if (!options.adapter || options.adapter === 'http') options.adapter = 'mock';
  if (options.adapter === 'mock' && !options.mockDecision) options.mockDecision = 'rejected';
  delete options.serverUrl;
  options.checkBackend = false;
}

function readConfig(paths: CodexConfigPaths): string {
  if (!fs.existsSync(paths.configPath)) return '';
  return fs.readFileSync(paths.configPath, 'utf8');
}

function currentCliPath(): string {
  const candidate = process.argv[1] || path.join(process.cwd(), 'dist', 'index.js');
  return path.resolve(candidate);
}

function nodeMajorVersion(): number {
  return Number(process.version.replace(/^v/, '').split('.')[0] || '0');
}

function parseAdapter(value: string | undefined): CodexConfigAdapter | undefined {
  if (value === 'mock' || value === 'file' || value === 'http') return value;
  return undefined;
}

function parseMockDecision(value: string | undefined): CodexApprovalStatus | undefined {
  if (value === 'approved' || value === 'rejected' || value === 'timeout' || value === 'pending') return value;
  return undefined;
}

function parseHookProfile(value: string | undefined): CodexConfigHookProfile | undefined {
  if (value === 'minimal' || value === 'guarded' || value === 'full') return value;
  return undefined;
}
