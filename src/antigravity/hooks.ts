import type {
  AntigravityApprovalDecision,
  AntigravityHookEventName,
  AntigravityHookHandleOptions,
  AntigravityHookHandleResult,
  AntigravityHookProfile,
  AntigravityMetadata,
  AntigravityPostToolUseInput,
  AntigravityInvocationInput,
  AntigravityPreToolUseInput,
  AntigravityPreToolUseOutput,
  AntigravityStopInput,
  NormalizedAntigravityEvent,
  OrbiterAntigravityApprovalRequest,
} from './types.js';
import {
  ANTIGRAVITY_HOOK_EVENTS,
  antigravityInvocationInputSchema,
  antigravityPostToolUseInputSchema,
  antigravityPreToolUseInputSchema,
  antigravityStopInputSchema,
} from './types.js';
import { antigravityRiskRequiresApproval, evaluateAntigravityRiskWithPolicy, isCriticalAntigravityRisk, recordFromArgs } from './risk.js';
import { isTrustedOrbiterInternalTool } from '../policy/internalTools.js';
import { createCodexApprovalAdapter } from '../codex/approvalAdapters.js';
import { postCodexJson } from '../codex/approvalClient.js';
import { isRecord, safeJson, sha256Hex, stableStringify, truncate } from '../codex/json.js';
import { redactValue } from '../codex/redaction.js';
import { mcpComponentVersion } from '../version.js';

export function parseAntigravityHookEventName(value: string | undefined): AntigravityHookEventName {
  if (value && ANTIGRAVITY_HOOK_EVENTS.includes(value as AntigravityHookEventName)) {
    return value as AntigravityHookEventName;
  }
  throw new Error(`Unsupported Antigravity hook event: ${String(value)}`);
}

export async function handleAntigravityHook(
  value: unknown,
  options: AntigravityHookHandleOptions = {},
): Promise<AntigravityHookHandleResult> {
  const eventName = options.eventName || 'PreToolUse';
  const profile = options.profile || 'blocking';

  if (eventName === 'PreToolUse') {
    const parsed = antigravityPreToolUseInputSchema.safeParse(value);
    if (!parsed.success) {
      return { output: preToolDeny(`Invalid Antigravity PreToolUse payload: ${parsed.error.message}`) };
    }
    return handlePreToolUse(parsed.data, { ...options, profile });
  }

  if (eventName === 'PostToolUse') {
    const parsed = antigravityPostToolUseInputSchema.safeParse(value);
    if (!parsed.success) return { output: {} };
    await maybeReportAntigravityToolResult(parsed.data);
    return { output: {} };
  }

  if (eventName === 'PreInvocation') {
    const parsed = antigravityInvocationInputSchema.safeParse(value);
    if (!parsed.success) return { output: {} };
    await maybeReportAntigravityHeartbeat(parsed.data, 'working', 'Antigravity model invocation starting');
    return { output: buildPreInvocationOutput(profile) };
  }

  if (eventName === 'PostInvocation') {
    const parsed = antigravityInvocationInputSchema.safeParse(value);
    if (!parsed.success) return { output: {} };
    return { output: { injectSteps: [], terminationBehavior: '' } };
  }

  if (eventName === 'Stop') {
    const parsed = antigravityStopInputSchema.safeParse(value);
    if (!parsed.success) return { output: { decision: '', reason: 'Orbiter ignored malformed Stop payload.' } };
    await maybeReportAntigravityHeartbeat(
      parsed.data,
      parsed.data.error ? 'error' : 'idle',
      `Antigravity execution stopped: ${parsed.data.terminationReason}`,
    );
    if (!parsed.data.fullyIdle && profile === 'strict') {
      return { output: { decision: 'continue', reason: 'Orbiter strict mode: wait for background tasks to finish before stopping.' } };
    }
    return { output: { decision: '' } };
  }

  return { output: {} };
}

export function normalizeAntigravityPreToolUse(raw: AntigravityPreToolUseInput, profile: AntigravityHookProfile = 'blocking'): NormalizedAntigravityEvent {
  const toolName = raw.toolCall.name;
  const toolArgs = recordFromArgs(raw.toolCall.args);
  const redactedArgs = redactValue(toolArgs);
  const inputHash = sha256Hex(redactedArgs);
  const preview = safeJson(redactedArgs, 1800);
  const conversationId = stringOr(raw.conversationId, 'unknown-conversation');
  const stepIdx = Number.isFinite(raw.stepIdx) ? raw.stepIdx : -1;
  const allowedWorkspacePaths = raw.artifactDirectoryPath
    ? [...raw.workspacePaths, raw.artifactDirectoryPath]
    : raw.workspacePaths;
  const risk = evaluateAntigravityRiskWithPolicy(toolName, toolArgs, allowedWorkspacePaths);
  const idempotencyKey = [
    'antigravity',
    conversationId,
    String(stepIdx),
    toolName,
    inputHash,
  ].join(':');
  const action = buildAction(toolName, redactedArgs);
  const description = buildDescription(toolName, redactedArgs, risk.reasons);
  // ORB-32: Do not duplicate tool_input_json preview inside diff_summary.
  // Structured hook preview metadata already travels in tool_input_json and
  // is hydrated on read by the backend for mobile UI compatibility.
  const diffSummary = '';
  const metadata: AntigravityMetadata = {
    source_ide: 'antigravity',
    source_runtime: 'antigravity_2',
    antigravity_conversation_id: conversationId,
    antigravity_step_idx: stepIdx,
    antigravity_tool_name: toolName,
    antigravity_hook_event_name: 'PreToolUse',
    antigravity_workspace_paths: raw.workspacePaths,
    antigravity_transcript_path_present: typeof raw.transcriptPath === 'string' && raw.transcriptPath.length > 0,
    antigravity_artifact_directory_present: typeof raw.artifactDirectoryPath === 'string' && raw.artifactDirectoryPath.length > 0,
    antigravity_tool_input_hash: inputHash,
    antigravity_tool_input_preview: preview,
    antigravity_idempotency_key: idempotencyKey,
  };
  const approval: OrbiterAntigravityApprovalRequest = {
    action,
    description,
    diff_summary: diffSummary,
    file_count: estimateFileCount(redactedArgs),
    risk_level: risk.level,
    source_ide: 'antigravity',
    source_extension_version: mcpComponentVersion('antigravity'),
    workspace_name: antigravityWorkspaceName(raw.workspacePaths),
    mcp_permission_id: idempotencyKey,
    tool_name: toolName,
    tool_input_json: JSON.stringify({
      payload_mode: 'redacted_preview',
      preview,
      hash: inputHash,
      antigravity: {
        conversation_id: conversationId,
        step_idx: stepIdx,
        hook_event_name: 'PreToolUse',
        tool_name: toolName,
        workspace_count: raw.workspacePaths.length,
      },
    }, null, 2),
    auto_approve: false,
    codex_session_id: conversationId,
    codex_turn_id: String(stepIdx),
    codex_tool_use_id: idempotencyKey,
    codex_hook_event_name: 'AntigravityPreToolUse',
    codex_tool_input_hash: inputHash,
    codex_tool_input_preview: preview,
    codex_idempotency_key: idempotencyKey,
  };

  return {
    raw,
    metadata,
    approval,
    risk,
    isOrbiterLoop: isTrustedOrbiterInternalTool(toolName),
    requiresApproval: antigravityRiskRequiresApproval(toolName, risk, profile),
  };
}

async function handlePreToolUse(
  payload: AntigravityPreToolUseInput,
  options: AntigravityHookHandleOptions & { profile: AntigravityHookProfile },
): Promise<AntigravityHookHandleResult> {
  const normalized = normalizeAntigravityPreToolUse(payload, options.profile);
  const permissionOverrides = buildAntigravityPermissionOverrides(normalized);

  if (normalized.isOrbiterLoop) {
    return { output: preToolAllow('Allowed Orbiter hook loop-prevention command.'), normalized };
  }

  if (isCriticalAntigravityRisk(normalized.risk)) {
    // Observe is log-only by contract: it must never block, including critical
    // (pre-2026-07 it hard-denied critical even in observe - a silent contract break).
    if (options.profile === 'observe') {
      return {
        output: preToolAllow(`Observe profile (log-only); critical risk noted: ${normalized.risk.reasons.join(' ')}`),
        normalized,
      };
    }
    // Critical routes to the phone by default (the phone stays the only approver);
    // --critical deny restores the pre-2026-07 local hard-deny.
    if ((options.criticalMode || 'ask') === 'deny') {
      return { output: preToolDeny(`Blocked by Orbiter policy: ${normalized.risk.reasons.join(' ')}`), normalized };
    }
    const decision = await requestAntigravityDecision(normalized, options);
    return {
      output: mapDecisionToPreToolUseOutput(decision, options.fallback || 'deny', permissionOverrides),
      normalized,
      decision,
    };
  }

  if (!normalized.requiresApproval) {
    return {
      output: preToolAllow(
        `Allowed by Orbiter ${options.profile} policy: ${normalized.risk.reasons.join(' ')}`,
        permissionOverrides,
      ),
      normalized,
    };
  }

  const decision = await requestAntigravityDecision(normalized, options);
  return {
    output: mapDecisionToPreToolUseOutput(decision, options.fallback || 'deny', permissionOverrides),
    normalized,
    decision,
  };
}

async function requestAntigravityDecision(
  normalized: NormalizedAntigravityEvent,
  options: AntigravityHookHandleOptions,
): Promise<AntigravityApprovalDecision> {
  // Options are passed explicitly - never via process.env (hidden global state).
  const adapter = createCodexApprovalAdapter(options.adapter, {
    serverUrl: options.serverUrl,
    timeoutSeconds: options.timeoutSeconds,
    mockDecision: options.mockDecision,
  });
  try {
    return await adapter.requestApproval(normalized.approval);
  } catch (error) {
    return {
      status: 'timeout',
      notes: `Orbiter Antigravity approval adapter failed: ${String(error)}`,
      timedOut: true,
      source: adapter.name,
    };
  }
}

export function mapDecisionToPreToolUseOutput(
  decision: AntigravityApprovalDecision,
  fallback: 'deny' | 'force_ask' = 'deny',
  permissionOverrides: string[] = [],
): AntigravityPreToolUseOutput {
  if (decision.status === 'approved') {
    return preToolAllow(decision.notes || 'Approved in Orbiter.', permissionOverrides);
  }
  if (decision.status === 'rejected') {
    return preToolDeny(decision.notes || 'Rejected in Orbiter.');
  }
  if (fallback === 'force_ask') {
    return {
      decision: 'force_ask',
      reason: decision.notes || 'Orbiter approval did not complete; forcing Antigravity local confirmation.',
    };
  }
  return preToolDeny(decision.notes || 'Orbiter approval did not complete; fail-closed deny.');
}

export function preToolAllow(reason: string, permissionOverrides: string[] = []): AntigravityPreToolUseOutput {
  const output: AntigravityPreToolUseOutput = { decision: 'allow', reason };
  if (permissionOverrides.length) output.permissionOverrides = permissionOverrides;
  return output;
}

export function preToolDeny(reason: string): AntigravityPreToolUseOutput {
  return { decision: 'deny', reason };
}

function buildAction(toolName: string, redactedArgs: unknown): string {
  const command = extractString(redactedArgs, ['CommandLine', 'command', 'cmd']);
  if (command) return `Antigravity ${toolName}: ${truncate(command, 140)}`;
  const target = extractString(redactedArgs, ['TargetFile', 'AbsolutePath', 'DirectoryPath', 'SearchPath', 'Target', 'Url']);
  if (target) return `Antigravity ${toolName}: ${truncate(target, 140)}`;
  return `Antigravity ${toolName}`;
}

function buildDescription(toolName: string, redactedArgs: unknown, reasons: string[]): string {
  const summary = reasons.length ? reasons.join(' ') : 'Antigravity is about to execute a tool.';
  return `${summary}\n\nTool: ${toolName}\nArguments preview:\n${safeJson(redactedArgs, 1000)}`;
}

function extractString(value: unknown, keys: string[]): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const item = value[key];
    if (typeof item === 'string' && item.trim()) return item;
  }
  return undefined;
}

function estimateFileCount(input: unknown): number {
  const text = stableStringify(input);
  const matches = text.match(/(?:[A-Za-z]:\\|\.{0,2}\/)[^"'\s]+/g);
  return matches ? Math.min(matches.length, 999) : 0;
}

function antigravityWorkspaceName(workspacePaths: string[]): string {
  if (!workspacePaths.length) return 'Antigravity Project';
  const names = workspacePaths.map((workspace) => workspace.replace(/\\/g, '/').split('/').filter(Boolean).pop() || workspace);
  return names.length === 1 ? names[0] : `${names[0]} + ${names.length - 1} more`;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function buildPreInvocationOutput(profile: AntigravityHookProfile): Record<string, unknown> {
  if (profile !== 'strict') return {};
  return {
    injectSteps: [
      {
        ephemeralMessage: 'Orbiter approval gate is active. Route terminal, file write, network, browser, MCP, schedule, subagent, and permission-grant actions through mobile approval; prefer workspace-scoped reads when possible.',
      },
    ],
  };
}

function buildAntigravityPermissionOverrides(normalized: NormalizedAntigravityEvent): string[] {
  const toolName = normalized.raw.toolCall.name;
  const args = recordFromArgs(normalized.raw.toolCall.args);
  const overrides = new Set<string>();

  if (toolName === 'run_command') {
    addCommandPermissionOverrides(overrides, extractString(args, ['CommandLine', 'command', 'cmd']));
  } else if (toolName === 'view_file' || toolName === 'read_file') {
    addPermissionOverride(overrides, 'read_file', extractString(args, ['AbsolutePath', 'Path']));
  } else if (toolName === 'list_dir') {
    addPermissionOverride(overrides, 'read_file', extractString(args, ['DirectoryPath']));
  } else if (toolName === 'find_by_name') {
    addPermissionOverride(overrides, 'read_file', extractString(args, ['SearchDirectory']));
  } else if (toolName === 'grep_search') {
    addPermissionOverride(overrides, 'read_file', extractString(args, ['SearchDirectory', 'SearchPath']));
  } else if (toolName === 'write_to_file' || toolName === 'replace_file_content' || toolName === 'multi_replace_file_content') {
    addPermissionOverride(overrides, 'write_file', extractString(args, ['TargetFile']));
  } else if (toolName === 'read_url_content') {
    addPermissionOverride(overrides, 'read_url', extractString(args, ['Url', 'url']));
  } else if (toolName === 'search_web') {
    addPermissionOverride(overrides, 'read_url', extractString(args, ['domain', 'Domain']));
  } else if (toolName === 'browser' || toolName.startsWith('browser_')) {
    addPermissionOverride(overrides, 'execute_url', extractString(args, ['Url', 'url', 'URL', 'PageUrl', 'TargetUrl']));
  } else if (toolName === 'mcp' || toolName.startsWith('mcp_')) {
    addMcpPermissionOverride(overrides, toolName, args);
  }

  return Array.from(overrides).slice(0, 8);
}

function addMcpPermissionOverride(overrides: Set<string>, toolName: string, args: Record<string, unknown>): void {
  const explicitTarget = extractString(args, ['target', 'Target', 'permissionTarget', 'PermissionTarget']);
  const safeExplicitTarget = safeMcpTarget(explicitTarget);
  if (safeExplicitTarget) {
    addPermissionOverride(overrides, 'mcp', safeExplicitTarget);
    return;
  }

  const parsedToolName = parseMcpToolName(toolName);
  const server = safeMcpPart(extractString(args, ['server', 'Server', 'serverName', 'ServerName', 'mcpServer', 'McpServer'])) || parsedToolName?.server;
  const tool = safeMcpPart(extractString(args, ['tool', 'Tool', 'toolName', 'ToolName', 'mcpTool', 'McpTool', 'method', 'Method'])) || parsedToolName?.tool;

  if (server && tool) {
    addPermissionOverride(overrides, 'mcp', `${server}/${tool}`);
  } else if (server) {
    addPermissionOverride(overrides, 'mcp', `${server}/*`);
  } else if (tool === '*') {
    addPermissionOverride(overrides, 'mcp', '*');
  }
}

function parseMcpToolName(toolName: string): { server: string; tool: string } | undefined {
  const doubleUnderscore = toolName.match(/^mcp__([^_]+(?:_[^_]+)*)__([^_]+(?:_[^_]+)*)$/);
  if (doubleUnderscore) {
    const server = safeMcpPart(doubleUnderscore[1]);
    const tool = safeMcpPart(doubleUnderscore[2]);
    return server && tool ? { server, tool } : undefined;
  }

  const singleUnderscore = toolName.match(/^mcp_([^_]+)_([^]+)$/);
  if (singleUnderscore) {
    const server = safeMcpPart(singleUnderscore[1]);
    const tool = safeMcpPart(singleUnderscore[2]);
    return server && tool ? { server, tool } : undefined;
  }

  return undefined;
}

function safeMcpTarget(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed === '*') return '*';
  const match = trimmed.match(/^([A-Za-z0-9._-]+)\/([A-Za-z0-9._*-]+)$/);
  if (!match) return undefined;
  const server = safeMcpPart(match[1]);
  const tool = safeMcpPart(match[2]);
  return server && tool ? `${server}/${tool}` : undefined;
}

function safeMcpPart(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 120) return undefined;
  if (!/^[A-Za-z0-9._*-]+$/.test(trimmed)) return undefined;
  return trimmed;
}

function addCommandPermissionOverrides(overrides: Set<string>, command: string | undefined): void {
  for (const target of commandPermissionTargets(command)) {
    addPermissionOverride(overrides, 'command', target);
  }
}

function commandPermissionTargets(command: string | undefined): string[] {
  const safeCommand = safePermissionTarget(command);
  if (!safeCommand) return [];

  const targets = new Set<string>();
  if (!hasPermissionResourceControlChars(safeCommand)) {
    targets.add(safeCommand);
  } else {
    const prefix = commandPermissionPrefix(safeCommand);
    if (prefix) targets.add(prefix);
  }

  return Array.from(targets);
}

function commandPermissionPrefix(command: string): string | undefined {
  const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  const simpleTokens: string[] = [];
  for (const token of tokens.slice(0, 2)) {
    const cleanToken = token.replace(/^["']|["']$/g, '');
    if (!/^[A-Za-z0-9._:/\\-]+$/.test(cleanToken)) break;
    simpleTokens.push(cleanToken);
  }
  if (tokens.length > 1 && simpleTokens.length < 2) return undefined;
  return simpleTokens.length > 0 ? simpleTokens.join(' ') : undefined;
}

function hasPermissionResourceControlChars(value: string): boolean {
  return /[()"'`\r\n]/.test(value);
}

function addPermissionOverride(overrides: Set<string>, action: string, target: string | undefined): void {
  const safeTarget = safePermissionTarget(target);
  if (!safeTarget) return;
  overrides.add(`${action}(${safeTarget})`);
}

function safePermissionTarget(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 500) return undefined;
  if (containsSecretLikeValue(trimmed)) return undefined;
  return trimmed;
}

function containsSecretLikeValue(value: string): boolean {
  return /(sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{20,}|ghp_[0-9A-Za-z]{20,}|xox[baprs]-[0-9A-Za-z-]{20,}|BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY)/.test(value);
}

async function maybeReportAntigravityToolResult(payload: AntigravityPostToolUseInput): Promise<void> {
  if (!antigravityTelemetryEnabled()) return;
  const sessionId = antigravitySessionId(payload.conversationId);
  if (!sessionId) return;
  try {
    const errorMessage = payload.error ? truncate(payload.error, 600) : '';
    await postCodexJson('/api/v1/agent/tool-result', {
      session_id: sessionId,
      tool_name: 'AntigravityPostToolUse',
      success: !errorMessage,
      error_message: errorMessage,
      file_path: '',
      duration_ms: 0,
    });
  } catch (error) {
    process.stderr.write(`[orbiter-antigravity] PostToolUse telemetry failed: ${String(error)}\n`);
  }
}

async function maybeReportAntigravityHeartbeat(
  payload: AntigravityInvocationInput | AntigravityStopInput,
  state: 'idle' | 'working' | 'waiting' | 'error',
  task: string,
): Promise<void> {
  if (!antigravityTelemetryEnabled()) return;
  const sessionId = antigravitySessionId(payload.conversationId);
  if (!sessionId) return;
  try {
    await postCodexJson('/api/v1/agent/heartbeat', {
      session_id: sessionId,
      state,
      task,
    });
  } catch (error) {
    process.stderr.write(`[orbiter-antigravity] Heartbeat telemetry failed: ${String(error)}\n`);
  }
}

function antigravityTelemetryEnabled(): boolean {
  return process.env.ORBITER_ANTIGRAVITY_REPORT_TELEMETRY === 'true';
}

function antigravitySessionId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : undefined;
}
