import fs from 'fs';
import os from 'os';
import path from 'path';
import type {
  AntigravityApprovalAdapterName,
  AntigravityApprovalFallback,
  AntigravityApprovalStatus,
  AntigravityHookProfile,
} from '../antigravity/types.js';
import {
  analyzeAntigravityHooksConfig,
  getAntigravityHookRunnerPath,
  getAntigravityHooksPaths,
  patchAntigravityHooksConfig,
  readAntigravityHooksConfig,
  removeAntigravityHookRunner,
  unpatchAntigravityHooksConfig,
  writeAntigravityHookRunner,
  writeAntigravityHooksConfig,
  type AntigravityConfigAnalysis,
  type AntigravityConfigPatchOptions,
  type AntigravityConfigScope,
} from '../antigravity/config.js';
import { handleAntigravityHook } from '../antigravity/hooks.js';

interface AntigravityConfigCommandOptions extends AntigravityConfigPatchOptions {
  scope?: AntigravityConfigScope;
  workspace?: string;
  dryRun?: boolean;
  checkBackend?: boolean;
  configureNativeCommandPolicy?: boolean;
}

interface DoctorCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export async function handleAntigravityConfigCommand(args: string[]): Promise<void> {
  const subcommand = args[0] && !args[0].startsWith('--') ? args[0] : 'doctor';
  const options = parseAntigravityConfigArgs(subcommand === args[0] ? args.slice(1) : args);

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

  throw new Error(`Unknown antigravity subcommand: ${subcommand}`);
}

function runSetup(options: AntigravityConfigCommandOptions): Record<string, unknown> {
  const workspaceRoot = path.resolve(options.workspace || process.cwd());
  const paths = getAntigravityHooksPaths(options.scope || 'workspace', workspaceRoot);
  const before = readAntigravityHooksConfig(paths);
  const cliPath = currentCliPath();
  const patched = patchAntigravityHooksConfig(before, { cliPath }, options);
  const configChanged = patched !== before;
  const runnerPath = getAntigravityHookRunnerPath(paths);
  const runnerChanged = !fs.existsSync(runnerPath) || !runnerReferencesCli(fs.readFileSync(runnerPath, 'utf8'), cliPath);
  const changed = configChanged || runnerChanged;

  if (!options.dryRun) {
    if (configChanged) {
      writeAntigravityHooksConfig(paths, patched, 'orbiter-dev-antigravity');
    }
    writeAntigravityHookRunner(paths, cliPath);
  }

  const parsedPreview = JSON.parse(patched) as Record<string, unknown>;
  const nativeCommandPolicy = options.configureNativeCommandPolicy
    ? configureNativeCommandPolicy(workspaceRoot, Boolean(options.dryRun))
    : inspectNativeCommandPolicy(workspaceRoot);
  return {
    success: true,
    action: 'setup',
    dryRun: Boolean(options.dryRun),
    changed,
    configChanged,
    runnerChanged,
    runnerPath,
    paths,
    analysis: analyzeAntigravityHooksConfig(patched, cliPath),
    nativeCommandPolicy,
    managedHookPreview: options.dryRun ? parsedPreview['orbiter-approval-gate'] : undefined,
  };
}

function runUninstall(options: AntigravityConfigCommandOptions): Record<string, unknown> {
  const paths = getAntigravityHooksPaths(options.scope || 'workspace', options.workspace || process.cwd());
  const before = readAntigravityHooksConfig(paths);
  const next = unpatchAntigravityHooksConfig(before);
  const configChanged = next !== before;
  const runnerPath = getAntigravityHookRunnerPath(paths);
  const runnerRemoved = !options.dryRun && removeAntigravityHookRunner(paths);
  const changed = configChanged || runnerRemoved || (options.dryRun && fs.existsSync(runnerPath));

  if (!options.dryRun && configChanged) {
    writeAntigravityHooksConfig(paths, next, 'orbiter-dev-antigravity-uninstall');
  }

  return {
    success: true,
    action: 'uninstall',
    dryRun: Boolean(options.dryRun),
    changed,
    configChanged,
    runnerRemoved,
    runnerPath,
    paths,
    analysis: analyzeAntigravityHooksConfig(next, currentCliPath()),
  };
}

async function runDoctor(options: AntigravityConfigCommandOptions): Promise<Record<string, unknown>> {
  const workspaceRoot = path.resolve(options.workspace || process.cwd());
  const paths = getAntigravityHooksPaths(options.scope || 'workspace', workspaceRoot);
  const cliPath = currentCliPath();
  const config = readAntigravityHooksConfig(paths);
  const runnerPath = getAntigravityHookRunnerPath(paths);
  let analysis = analyzeAntigravityHooksConfig(config, cliPath);
  let configParses = true;
  try {
    if (config.trim()) JSON.parse(config) as unknown;
  } catch {
    configParses = false;
    analysis = analyzeAntigravityHooksConfig('', cliPath);
  }

  const checks: DoctorCheck[] = [
    {
      name: 'node_version',
      ok: nodeMajorVersion() >= 18,
      detail: process.version,
    },
    {
      name: 'hooks_config_path',
      ok: fs.existsSync(paths.configPath),
      detail: paths.configPath,
    },
    {
      name: 'hooks_config_json_parses',
      ok: configParses,
    },
    {
      name: 'hook_runner_present',
      ok: fs.existsSync(runnerPath),
      detail: runnerPath,
    },
    {
      name: 'hook_runner_references_cli',
      ok: fs.existsSync(runnerPath) && runnerReferencesCli(fs.readFileSync(runnerPath, 'utf8'), cliPath),
      detail: cliPath,
    },
    {
      name: 'owned_hook_present',
      ok: analysis.ownedHookPresent,
    },
    {
      name: 'owned_hook_enabled',
      ok: analysis.ownedHookEnabled,
    },
    {
      name: 'pretooluse_hook_present',
      ok: analysis.preToolUseHookCount === 1,
      detail: String(analysis.preToolUseHookCount),
    },
    {
      name: 'posttooluse_hook_present',
      ok: analysis.postToolUseHookCount === 1,
      detail: String(analysis.postToolUseHookCount),
    },
    {
      name: 'preinvocation_hook_present',
      ok: analysis.preInvocationHookCount === 1,
      detail: String(analysis.preInvocationHookCount),
    },
    {
      name: 'postinvocation_hook_present',
      ok: analysis.postInvocationHookCount === 1,
      detail: String(analysis.postInvocationHookCount),
    },
    {
      name: 'stop_hook_present',
      ok: analysis.stopHookCount === 1,
      detail: String(analysis.stopHookCount),
    },
    {
      name: 'pretooluse_matches_all',
      ok: analysis.matcher === '*',
      detail: analysis.matcher,
    },
    {
      name: 'pretooluse_timeout_blocking_window',
      ok: (analysis.timeoutSeconds || 0) >= 300,
      detail: String(analysis.timeoutSeconds || 0),
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

  checks.push(await dryRunPreToolUseCheck(options, analysis));

  if (options.checkBackend) {
    checks.push(await backendHealthCheck(options.serverUrl));
  }

  checks.push(nativeCommandPolicyCheck(workspaceRoot));

  return {
    success: checks.every((check) => check.ok),
    action: 'doctor',
    paths,
    analysis,
    nativeCommandPolicy: inspectNativeCommandPolicy(workspaceRoot),
    checks,
  };
}

async function dryRunPreToolUseCheck(
  options: AntigravityConfigCommandOptions,
  analysis: AntigravityConfigAnalysis,
): Promise<DoctorCheck> {
  const mockDecision = options.mockDecision || analysis.mockDecision || 'approved';
  const expectedDecision = mockDecision === 'approved' ? 'allow' : 'deny';
  try {
    const result = await handleAntigravityHook({
      toolCall: {
        name: 'run_command',
        args: {
          CommandLine: 'git status --short',
          Cwd: process.cwd(),
          WaitMsBeforeAsync: 1000,
        },
      },
      stepIdx: 1,
      conversationId: 'orbiter-antigravity-doctor-conversation',
      workspacePaths: [process.cwd()],
      transcriptPath: path.join(process.cwd(), '.gemini', 'jetski', 'transcript.jsonl'),
      artifactDirectoryPath: path.join(process.cwd(), '.gemini', 'jetski', 'artifacts'),
    }, {
      eventName: 'PreToolUse',
      adapter: 'mock',
      mockDecision,
      timeoutSeconds: options.approvalTimeoutSeconds || 300,
      profile: options.profile || 'blocking',
      fallback: options.fallback || 'deny',
    });
    const output = result.output as { decision?: string };

    return {
      name: 'pretooluse_mock_roundtrip',
      ok: output.decision === expectedDecision,
      detail: JSON.stringify({
        mockDecision,
        expectedDecision,
        output: result.output,
      }),
    };
  } catch (error) {
    return {
      name: 'pretooluse_mock_roundtrip',
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

function parseAntigravityConfigArgs(args: string[]): AntigravityConfigCommandOptions {
  const options: AntigravityConfigCommandOptions = {
    scope: 'workspace',
    profile: 'blocking',
    fallback: 'deny',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--dry-run') {
      options.dryRun = true;
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
    } else if (arg === '--fallback') {
      const fallback = parseFallback(next);
      if (fallback) options.fallback = fallback;
      i++;
    } else if (arg === '--critical') {
      if (next === 'ask' || next === 'deny') options.criticalMode = next;
      i++;
    } else if (arg === '--offline-capture') {
      options.offlineCapture = true;
    } else if (arg === '--capture-dir') {
      options.captureDir = next;
      i++;
    } else if (arg === '--check-backend') {
      options.checkBackend = true;
    } else if (arg === '--configure-native-command-policy' || arg === '--configure-agy-native-command-policy') {
      options.configureNativeCommandPolicy = true;
    }
  }

  applyOfflineCaptureConfigDefaults(options);
  return options;
}

function applyOfflineCaptureConfigDefaults(options: AntigravityConfigCommandOptions): void {
  if (!options.offlineCapture) return;
  options.captureDir ||= '.tmp_hook_captures';
  if (!options.adapter || options.adapter === 'http') options.adapter = 'mock';
  if (options.adapter === 'mock' && !options.mockDecision) options.mockDecision = 'rejected';
  delete options.serverUrl;
  options.checkBackend = false;
}

interface NativeCommandPolicyInspection {
  found: boolean;
  projectConfigPath?: string;
  projectName?: string;
  autoExecutionPolicy?: string;
  readyForOrbiterGate: boolean;
  backupPath?: string;
  changed?: boolean;
  dryRun?: boolean;
  message?: string;
}

function nativeCommandPolicyCheck(workspaceRoot: string): DoctorCheck {
  const inspection = inspectNativeCommandPolicy(workspaceRoot);
  return {
    name: 'native_terminal_policy_allows_orbiter_gate',
    ok: !inspection.found || inspection.readyForOrbiterGate,
    detail: inspection.found
      ? `${inspection.projectName || 'project'}: ${inspection.autoExecutionPolicy || 'missing'}`
      : inspection.message,
  };
}

function inspectNativeCommandPolicy(workspaceRoot: string): NativeCommandPolicyInspection {
  const project = findNativeProjectConfig(workspaceRoot);
  if (!project) {
    return {
      found: false,
      readyForOrbiterGate: false,
      message: `No Antigravity project config found under ${antigravityProjectsDir()} for ${workspaceRoot}`,
    };
  }

  return {
    found: true,
    projectConfigPath: project.path,
    projectName: stringOrUndefined(project.data.name),
    autoExecutionPolicy: stringOrUndefined(project.data.settings?.autoExecutionPolicy),
    readyForOrbiterGate: project.data.settings?.autoExecutionPolicy === 'CASCADE_COMMANDS_AUTO_EXECUTION_EAGER',
  };
}

function configureNativeCommandPolicy(workspaceRoot: string, dryRun: boolean): NativeCommandPolicyInspection {
  const project = findNativeProjectConfig(workspaceRoot);
  if (!project) return inspectNativeCommandPolicy(workspaceRoot);

  const beforePolicy = stringOrUndefined(project.data.settings?.autoExecutionPolicy);
  const alreadyReady = beforePolicy === 'CASCADE_COMMANDS_AUTO_EXECUTION_EAGER';
  const result: NativeCommandPolicyInspection = {
    found: true,
    projectConfigPath: project.path,
    projectName: stringOrUndefined(project.data.name),
    autoExecutionPolicy: beforePolicy,
    readyForOrbiterGate: true,
    changed: !alreadyReady,
    dryRun,
  };

  if (alreadyReady || dryRun) return result;

  const backupPath = `${project.path}.orbiter-dev-native-${timestampForFile()}.bak`;
  const next = { ...project.data, settings: { ...(project.data.settings || {}) } };
  next.settings.autoExecutionPolicy = 'CASCADE_COMMANDS_AUTO_EXECUTION_EAGER';
  fs.copyFileSync(project.path, backupPath);
  fs.writeFileSync(project.path, `${JSON.stringify(next, null, 2)}\n`);
  return {
    ...result,
    autoExecutionPolicy: 'CASCADE_COMMANDS_AUTO_EXECUTION_EAGER',
    backupPath,
  };
}

interface NativeProjectConfig {
  path: string;
  data: {
    name?: unknown;
    settings?: {
      autoExecutionPolicy?: unknown;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
}

function findNativeProjectConfig(workspaceRoot: string): NativeProjectConfig | undefined {
  const projectsDir = antigravityProjectsDir();
  if (!fs.existsSync(projectsDir)) return undefined;
  const workspaceKey = normalizeComparablePath(workspaceRoot);
  for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const projectPath = path.join(projectsDir, entry.name);
    try {
      const data = JSON.parse(fs.readFileSync(projectPath, 'utf8')) as NativeProjectConfig['data'];
      for (const folderUri of collectFolderUris(data)) {
        const folderPath = fileUriToPath(folderUri);
        if (folderPath && normalizeComparablePath(folderPath) === workspaceKey) {
          return { path: projectPath, data };
        }
      }
    } catch {
      // Ignore malformed unrelated Antigravity project config files.
    }
  }
  return undefined;
}

function collectFolderUris(value: unknown): string[] {
  const uris: string[] = [];
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
      if (key === 'folderUri' && typeof child === 'string') uris.push(child);
      visit(child);
    }
  };
  visit(value);
  return uris;
}

function fileUriToPath(uri: string): string | undefined {
  if (!uri.startsWith('file:///')) return undefined;
  let decoded = decodeURIComponent(uri.slice('file:///'.length)).replace(/\//g, path.sep);
  if (/^[A-Za-z]:/.test(decoded)) return path.resolve(decoded);
  if (/^[/\\][A-Za-z]:/.test(decoded)) return path.resolve(decoded.slice(1));
  return path.resolve(decoded);
}

function normalizeComparablePath(value: string): string {
  return path.resolve(value).replace(/\//g, '\\').toLowerCase();
}

function antigravityProjectsDir(): string {
  if (process.env.ORBITER_ANTIGRAVITY_PROJECTS_DIR) return process.env.ORBITER_ANTIGRAVITY_PROJECTS_DIR;
  return path.join(os.homedir(), '.gemini', 'config', 'projects');
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function timestampForFile(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z');
}

function runnerReferencesCli(content: string, cliPath: string): boolean {
  const escapedCliPath = JSON.stringify(cliPath).slice(1, -1);
  return content.includes(cliPath) || content.includes(escapedCliPath);
}
function currentCliPath(): string {
  const candidate = process.argv[1] || path.join(process.cwd(), 'dist', 'index.js');
  return path.resolve(candidate);
}

function nodeMajorVersion(): number {
  return Number(process.version.replace(/^v/, '').split('.')[0] || '0');
}

function parseScope(value: string | undefined): AntigravityConfigScope | undefined {
  if (value === 'workspace' || value === 'global') return value;
  return undefined;
}

function parseAdapter(value: string | undefined): AntigravityApprovalAdapterName | undefined {
  if (value === 'mock' || value === 'file' || value === 'http') return value;
  return undefined;
}

function parseMockDecision(value: string | undefined): AntigravityApprovalStatus | undefined {
  if (value === 'approved' || value === 'rejected' || value === 'timeout' || value === 'pending') return value;
  return undefined;
}

function parseProfile(value: string | undefined): AntigravityHookProfile | undefined {
  if (value === 'observe' || value === 'blocking' || value === 'strict') return value;
  return undefined;
}

function parseFallback(value: string | undefined): AntigravityApprovalFallback | undefined {
  if (value === 'deny' || value === 'force_ask') return value;
  return undefined;
}
