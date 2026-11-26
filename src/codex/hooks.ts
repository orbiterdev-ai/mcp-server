import type {
  CodexApprovalDecision,
  CodexHookEvent,
  CodexHookEventName,
  CodexHookHandleOptions,
  CodexHookHandleResult,
  NormalizedCodexEvent,
  OrbiterCodexApprovalRequest,
} from './types.js';
import { isRecord, safeJson, sha256Hex, stableStringify, truncate } from './json.js';
import { redactValue } from './redaction.js';
import { evaluateHostToolRiskWithPolicy } from './risk.js';
import { isTrustedOrbiterInternalTool } from '../policy/internalTools.js';
import { meetsMinRisk, resolveMinRisk } from '../policy/ruleset.js';
import { codexSourceRuntimeFromEnv, codexWorkspaceName } from './workspace.js';
import { createCodexApprovalAdapter } from './approvalAdapters.js';
import { readCachedCodexDecision, writeCachedCodexDecision } from './idempotency.js';
import { postCodexJson } from './approvalClient.js';
import { mcpComponentVersion } from '../version.js';

const hookEvents: CodexHookEventName[] = [
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

export function parseCodexHookEvent(value: unknown): CodexHookEvent {
  if (!isRecord(value)) throw new Error('Codex hook payload must be an object');
  const eventName = value.hook_event_name;
  if (typeof eventName !== 'string' || !hookEvents.includes(eventName as CodexHookEventName)) {
    throw new Error(`Unsupported or missing hook_event_name: ${String(eventName)}`);
  }
  if (eventName === 'PermissionRequest' && typeof value.tool_name !== 'string') {
    throw new Error('PermissionRequest payload must include tool_name');
  }
  return value as unknown as CodexHookEvent;
}

export async function handleCodexHook(value: unknown, options: CodexHookHandleOptions = {}): Promise<CodexHookHandleResult> {
  let event: CodexHookEvent;
  try {
    event = parseCodexHookEvent(value);
  } catch (error) {
    const raw = isRecord(value) ? value : {};
    if (raw.hook_event_name === 'PermissionRequest') {
      return { output: permissionDeny(`Invalid Codex hook payload: ${String(error)}`) };
    }
    return { output: {} };
  }

  const normalized = normalizeCodexHookEvent(event);

  if (normalized.raw.hook_event_name === 'PostToolUse') {
    await maybeReportToolResult(normalized);
    return { output: {}, normalized };
  }

  if (normalized.raw.hook_event_name === 'SessionStart') {
    await maybeReportHeartbeat(normalized);
    return { output: {}, normalized };
  }

  if (normalized.raw.hook_event_name === 'PermissionRequest') {
    if (normalized.isOrbiterLoop) {
      return { output: permissionAllow(), normalized, decision: { status: 'approved', notes: 'Orbiter loop prevention', source: 'cache' } };
    }
    if (isCodexInternalPlanApproval(normalized)) {
      return { output: permissionAllow(), normalized, decision: { status: 'approved', notes: 'Codex internal plan confirmation bypass', source: 'cache' } };
    }
    const decision = await requestCodexDecision(normalized, options);
    return {
      output: decision.status === 'approved'
        ? permissionAllow()
        : decision.status === 'rejected'
          ? permissionDeny(decision.notes || 'Denied by Orbiter.')
          : (options.fallback === 'allow'
            ? permissionAllow()
            : permissionDeny(decision.notes || 'Orbiter approval did not complete; fail-closed deny.')),
      normalized,
      decision,
    };
  }

  if (normalized.raw.hook_event_name === 'PreToolUse') {
    if (normalized.isOrbiterLoop) return { output: {}, normalized };

    // Critical routes to the phone by default (the phone stays the only approver);
    // --critical deny restores the pre-2026-07 local hard-deny.
    if (normalized.risk === 'critical' && (options.criticalMode || 'ask') === 'deny') {
      return { output: preToolDeny('Blocked by Orbiter policy: critical risk.'), normalized };
    }

    // B-118: threshold is now shared across IDE surfaces. Default 'high' preserves the
    // historical isHighCodexRisk behavior (high + critical only) when ORBITER_MIN_RISK is unset.
    if (meetsMinRisk(normalized.risk, resolveMinRisk('high'))) {
      const decision = await requestCodexDecision(normalized, options);
      return {
        // An explicit rejection always denies; the fallback option only governs
        // incomplete decisions (timeout / adapter failure / pending).
        output: decision.status === 'approved'
          ? {}
          : decision.status === 'rejected'
            ? preToolDeny(decision.notes || 'Blocked by Orbiter approval decision.')
            : (options.fallback === 'allow'
              ? {}
              : preToolDeny(decision.notes || 'Orbiter approval did not complete; fail-closed deny.')),
        normalized,
        decision,
      };
    }
  }

  return { output: {}, normalized };
}

export function normalizeCodexHookEvent(raw: CodexHookEvent): NormalizedCodexEvent {
  const toolInput = raw.tool_input ?? {};
  const redactedInput = redactValue(toolInput);
  const inputHash = sha256Hex(toolInput);
  const preview = safeJson(redactedInput, 1800);
  const toolName = raw.tool_name || raw.hook_event_name;
  const action = buildAction(raw, redactedInput);
  const description = buildDescription(raw, preview);
  // ORB-32: Do not mirror tool_input_json preview inside diff_summary.
  const diffSummary = '';
  // Converged v2 policy: risk is classified over the tool call itself (toolName + full
  // redacted args), never over truncated display previews or description wording - the
  // same engine and input shape as every other surface. The legacy strings are passed
  // only for the ORBITER_HOOK_POLICY=v1/legacy escape hatches.
  const argsRecord = isRecord(redactedInput) ? redactedInput : { value: redactedInput };
  const risk = evaluateHostToolRiskWithPolicy(
    'codex',
    toolName,
    argsRecord,
    action,
    `${description}\n${stableStringify(redactedInput)}`,
  );
  const sessionId = stringOr(raw.session_id, 'unknown-session');
  const turnId = stringOr(raw.turn_id, 'unknown-turn');
  const toolUseId = stringOr(raw.tool_use_id, 'unknown-tool-use');
  const idempotencyKey = [
    'codex',
    sessionId,
    turnId,
    raw.hook_event_name,
    toolName,
    toolUseId,
    inputHash,
  ].join(':');

  const metadata = {
    source_ide: 'codex' as const,
    source_runtime: codexSourceRuntimeFromEnv(),
    codex_session_id: sessionId,
    codex_turn_id: turnId,
    codex_tool_use_id: toolUseId,
    codex_tool_name: toolName,
    codex_hook_event_name: raw.hook_event_name,
    codex_model: stringOr(raw.model, 'unknown'),
    codex_cwd: stringOr(raw.cwd, process.cwd()),
    codex_transcript_path_present: typeof raw.transcript_path === 'string' && raw.transcript_path.length > 0,
    codex_tool_input_hash: inputHash,
    codex_tool_input_preview: preview,
    codex_idempotency_key: idempotencyKey,
  };

  const approval: OrbiterCodexApprovalRequest = {
    action,
    description,
    diff_summary: diffSummary,
    file_count: estimateFileCount(redactedInput),
    risk_level: risk,
    source_ide: 'codex',
    source_extension_version: mcpComponentVersion('codex'),
    workspace_name: codexWorkspaceName(raw.cwd),
    thoughts: raw.hook_event_name === 'UserPromptSubmit' ? truncate(String(raw.prompt || ''), 1000) : undefined,
    mcp_permission_id: raw.tool_use_id,
    tool_name: toolName,
    tool_input_json: JSON.stringify({
      payload_mode: 'redacted_preview',
      preview,
      hash: inputHash,
      codex: {
        session_id: sessionId,
        turn_id: turnId,
        tool_use_id: toolUseId,
        hook_event_name: raw.hook_event_name,
        model: metadata.codex_model,
      },
    }, null, 2),
    auto_approve: risk === 'low',
    codex_session_id: sessionId,
    codex_turn_id: turnId,
    codex_tool_use_id: toolUseId,
    codex_hook_event_name: raw.hook_event_name,
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
  };
}

export function permissionAllow(): unknown {
  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow' },
    },
  };
}

export function permissionDeny(message: string): unknown {
  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: 'deny',
        message,
      },
    },
  };
}

export function preToolDeny(reason: string): unknown {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

async function requestCodexDecision(normalized: NormalizedCodexEvent, options: CodexHookHandleOptions): Promise<CodexApprovalDecision> {
  // Options are passed explicitly - never via process.env, which is hidden global state
  // that leaks one call's options into the next in long-lived processes and tests.
  const adapter = createCodexApprovalAdapter(options.adapter, {
    serverUrl: options.serverUrl,
    timeoutSeconds: options.timeoutSeconds,
    mockDecision: options.mockDecision,
  });
  const useCache = adapter.name !== 'mock';
  const cached = useCache ? readCachedCodexDecision(normalized.metadata.codex_idempotency_key) : undefined;
  if (cached) return cached;

  try {
    const decision = await adapter.requestApproval(normalized.approval);
    if (useCache) writeCachedCodexDecision(normalized.metadata.codex_idempotency_key, decision);
    return decision;
  } catch (error) {
    // An adapter FAILURE is not a user rejection: report it as 'timeout' so the caller's
    // fallback policy (fail-closed deny by default, fail-open when configured) governs.
    // The old shape reported 'rejected' for high risk, which lied about who decided.
    const decision: CodexApprovalDecision = {
      status: 'timeout',
      notes: `Orbiter Codex approval adapter failed: ${String(error)}`,
      timedOut: true,
      source: adapter.name,
    };
    if (useCache) writeCachedCodexDecision(normalized.metadata.codex_idempotency_key, decision);
    return decision;
  }
}

async function maybeReportToolResult(normalized: NormalizedCodexEvent): Promise<void> {
  if (process.env.ORBITER_CODEX_REPORT_TELEMETRY !== 'true') return;
  try {
    const responseText = safeJson(redactValue(normalized.raw.tool_response), 600);
    const failed = /error|failed|exception/i.test(responseText);
    await postCodexJson('/api/v1/agent/tool-result', {
      session_id: normalized.metadata.codex_session_id,
      tool_name: normalized.metadata.codex_tool_name,
      success: !failed,
      error_message: failed ? responseText : '',
      file_path: '',
      duration_ms: 0,
      codex_turn_id: normalized.metadata.codex_turn_id,
      codex_tool_use_id: normalized.metadata.codex_tool_use_id,
    });
  } catch (error) {
    process.stderr.write(`[orbiter-codex] PostToolUse telemetry failed: ${String(error)}\n`);
  }
}

async function maybeReportHeartbeat(normalized: NormalizedCodexEvent): Promise<void> {
  if (process.env.ORBITER_CODEX_REPORT_TELEMETRY !== 'true') return;
  try {
    await postCodexJson('/api/v1/agent/heartbeat', {
      session_id: normalized.metadata.codex_session_id,
      state: 'working',
      task: `Codex session ${normalized.metadata.codex_hook_event_name}`,
    });
  } catch (error) {
    process.stderr.write(`[orbiter-codex] SessionStart telemetry failed: ${String(error)}\n`);
  }
}

function buildAction(raw: CodexHookEvent, redactedInput: unknown): string {
  const command = extractCommand(redactedInput);
  if (command) return `Codex ${raw.tool_name || 'tool'}: ${truncate(command, 120)}`;
  if (raw.hook_event_name === 'UserPromptSubmit') return 'Codex user prompt submitted';
  if (raw.hook_event_name === 'Stop') return `Codex stop: ${String(raw.stop_reason || 'unknown')}`;
  return `Codex ${raw.hook_event_name}: ${raw.tool_name || 'session'}`;
}

function buildDescription(raw: CodexHookEvent, preview: string): string {
  if (raw.hook_event_name === 'PermissionRequest') return `Codex is requesting permission to run ${raw.tool_name || 'a tool'}.`;
  if (raw.hook_event_name === 'PreToolUse') return `Codex is about to run ${raw.tool_name || 'a tool'}.`;
  if (raw.hook_event_name === 'PostToolUse') return `Codex completed ${raw.tool_name || 'a tool'}.`;
  if (raw.hook_event_name === 'UserPromptSubmit') return truncate(String(raw.prompt || preview), 800);
  return `Codex hook event ${raw.hook_event_name}.`;
}

function extractCommand(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  const command = input.command ?? input.cmd ?? input.script;
  return typeof command === 'string' ? command : undefined;
}

function estimateFileCount(input: unknown): number {
  const text = stableStringify(input);
  const matches = text.match(/(?:[A-Za-z]:\\|\.{0,2}\/)[^"'\s]+/g);
  return matches ? Math.min(matches.length, 999) : 0;
}

function isCodexInternalPlanApproval(normalized: NormalizedCodexEvent): boolean {
  const raw = normalized.raw;
  if (raw.hook_event_name !== 'PermissionRequest') return false;

  const toolName = stringOr(raw.tool_name, '').trim().toLowerCase();
  const input = raw.tool_input ?? {};

  if (hasExecutionToolName(toolName) || hasExecutionShape(input)) {
    return false;
  }

  if (/^(plan|implementation[_ -]?plan|update[_ -]?plan)$/.test(toolName)) {
    return true;
  }

  const searchableText = [
    raw.tool_name,
    raw.prompt,
    raw.message,
    raw.reason,
    raw.description,
    raw.action,
    raw.title,
    raw.summary,
    raw.question,
    stableStringify(input),
  ]
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
    .toLowerCase();

  return [
    'implement this plan',
    'implementation plan',
    'approve this plan',
    'plan approval',
    'proposed plan',
    'submit plan',
  ].some((signal) => searchableText.includes(signal));
}

function hasExecutionToolName(toolName: string): boolean {
  return [
    'bash',
    'shell',
    'cmd',
    'powershell',
    'apply_patch',
    'file',
    'edit',
    'write',
    'mcp',
  ].some((executionTool) => toolName.includes(executionTool));
}

function hasExecutionShape(value: unknown, depth = 0): boolean {
  if (depth > 3) return false;
  if (Array.isArray(value)) {
    return value.some((item) => hasExecutionShape(item, depth + 1));
  }
  if (!isRecord(value)) return false;

  const executionKeys = new Set([
    'args',
    'cmd',
    'command',
    'diff',
    'edits',
    'file',
    'files',
    'patch',
    'path',
    'paths',
    'script',
    'tool_input',
    'tool_name',
  ]);

  for (const [key, nestedValue] of Object.entries(value)) {
    if (executionKeys.has(key.toLowerCase())) return true;
    if (hasExecutionShape(nestedValue, depth + 1)) return true;
  }

  return false;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}
