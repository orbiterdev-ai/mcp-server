import type {
  GeminiApprovalDecision,
  GeminiHookEvent,
  GeminiHookEventName,
  GeminiHookHandleOptions,
  GeminiHookHandleResult,
  NormalizedGeminiEvent,
  OrbiterGeminiApprovalRequest,
} from './types.js';
import { GEMINI_HOOK_EVENTS } from './types.js';
import { createCodexApprovalAdapter } from '../codex/approvalAdapters.js';
import { isRecord, safeJson, sha256Hex, stableStringify, truncate } from '../codex/json.js';
import { evaluateHostToolRiskWithPolicy } from '../codex/risk.js';
import { isTrustedOrbiterInternalTool } from '../policy/internalTools.js';
import { meetsMinRisk, resolveMinRisk } from '../policy/ruleset.js';
import { redactValue } from '../codex/redaction.js';
import { mcpComponentVersion } from '../version.js';

export function parseGeminiHookEvent(value: unknown, eventName?: GeminiHookEventName): GeminiHookEvent {
  if (!isRecord(value)) throw new Error('Gemini hook payload must be an object');
  const rawEventName = typeof value.hook_event_name === 'string' ? value.hook_event_name : eventName;
  if (!rawEventName || !GEMINI_HOOK_EVENTS.includes(rawEventName as GeminiHookEventName)) {
    throw new Error(`Unsupported or missing Gemini hook_event_name: ${String(rawEventName)}`);
  }
  const normalizedEvent = { ...value, hook_event_name: rawEventName } as GeminiHookEvent;
  if (rawEventName === 'BeforeTool' && typeof normalizedEvent.tool_name !== 'string') {
    throw new Error('BeforeTool payload must include tool_name');
  }
  return normalizedEvent;
}

export async function handleGeminiHook(value: unknown, options: GeminiHookHandleOptions = {}): Promise<GeminiHookHandleResult> {
  let event: GeminiHookEvent;
  try {
    event = parseGeminiHookEvent(value, options.eventName);
  } catch (error) {
    if (options.eventName === 'BeforeTool') return { output: deny(`Invalid Gemini hook payload: ${String(error)}`) };
    return { output: {} };
  }

  const normalized = normalizeGeminiHookEvent(event);

  if (event.hook_event_name !== 'BeforeTool') {
    return { output: {}, normalized };
  }

  if (normalized.isOrbiterLoop) {
    return { output: {}, normalized };
  }

  // Critical routes to the phone by default (the phone stays the only approver);
  // --critical deny restores the pre-2026-07 local hard-deny.
  if (normalized.risk === 'critical' && (options.criticalMode || 'ask') === 'deny') {
    return { output: deny('Blocked by Orbiter policy: critical risk.'), normalized };
  }

  // B-118: shared threshold. Default 'high' preserves the historical isHighCodexRisk
  // behavior (high + critical only) when ORBITER_MIN_RISK is unset.
  if (!meetsMinRisk(normalized.risk, resolveMinRisk('high'))) {
    return { output: {}, normalized };
  }

  const decision = await requestGeminiDecision(normalized, options);
  return {
    // An explicit rejection always denies; the fallback option only governs
    // incomplete decisions (timeout / adapter failure / pending).
    output: decision.status === 'approved'
      ? allow(decision.notes || 'Approved in Orbiter.')
      : decision.status === 'rejected'
        ? deny(decision.notes || 'Rejected by Orbiter.')
        : (options.fallback === 'allow'
          ? allow(decision.notes || 'Orbiter approval did not complete; fail-open allow (configured).')
          : deny(decision.notes || 'Orbiter approval did not complete; fail-closed deny.')),
    normalized,
    decision,
  };
}

export function normalizeGeminiHookEvent(raw: GeminiHookEvent): NormalizedGeminiEvent {
  const toolName = raw.tool_name || raw.hook_event_name;
  const payload = eventPayload(raw);
  const redactedPayload = redactValue(payload);
  const inputHash = sha256Hex(redactedPayload);
  const preview = safeJson(redactedPayload, 1800);
  const sessionId = stringOr(raw.session_id, 'unknown-session');
  const cwd = stringOr(raw.cwd, process.cwd());
  const action = buildAction(raw, redactedPayload);
  const description = buildDescription(raw, preview);
  // ORB-32: Do not mirror tool_input_json preview inside diff_summary.
  const diffSummary = '';
  // Converged v2 policy over the tool call itself (toolName + full redacted args); the
  // legacy strings serve only the ORBITER_HOOK_POLICY=v1/legacy escape hatches. See the
  // matching note in codex/hooks.ts.
  const payloadRecord = isRecord(redactedPayload) ? redactedPayload : { value: redactedPayload };
  const risk = evaluateHostToolRiskWithPolicy(
    'gemini',
    toolName,
    payloadRecord,
    action,
    `${description}\n${stableStringify(redactedPayload)}`,
  );
  const idempotencyKey = [
    'gemini-cli',
    sessionId,
    raw.hook_event_name,
    toolName,
    inputHash,
  ].join(':');

  const metadata = {
    source_ide: 'gemini_cli' as const,
    source_runtime: 'gemini_cli_hooks' as const,
    gemini_session_id: sessionId,
    gemini_hook_event_name: raw.hook_event_name,
    gemini_tool_name: toolName,
    gemini_cwd: cwd,
    gemini_transcript_path_present: typeof raw.transcript_path === 'string' && raw.transcript_path.length > 0,
    gemini_tool_input_hash: inputHash,
    gemini_tool_input_preview: preview,
    gemini_idempotency_key: idempotencyKey,
  };

  const approval: OrbiterGeminiApprovalRequest = {
    action,
    description,
    diff_summary: diffSummary,
    file_count: estimateFileCount(redactedPayload),
    risk_level: risk,
    source_ide: 'gemini_cli',
    source_extension_version: mcpComponentVersion('gemini-cli'),
    workspace_name: geminiWorkspaceName(cwd),
    mcp_permission_id: idempotencyKey,
    tool_name: toolName,
    tool_input_json: JSON.stringify({
      payload_mode: 'redacted_preview',
      preview,
      hash: inputHash,
      gemini_cli: {
        session_id: sessionId,
        hook_event_name: raw.hook_event_name,
        tool_name: toolName,
      },
    }, null, 2),
    auto_approve: false,
    codex_session_id: sessionId,
    codex_turn_id: raw.hook_event_name,
    codex_tool_use_id: idempotencyKey,
    codex_hook_event_name: `Gemini${raw.hook_event_name}`,
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

export function allow(message: string): unknown {
  return {
    decision: 'allow',
    systemMessage: `Orbiter approved Gemini CLI tool call: ${truncate(message, 240)}`,
  };
}

export function deny(reason: string): unknown {
  return {
    decision: 'deny',
    reason,
  };
}

async function requestGeminiDecision(
  normalized: NormalizedGeminiEvent,
  options: GeminiHookHandleOptions,
): Promise<GeminiApprovalDecision> {
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
      notes: `Orbiter Gemini CLI approval adapter failed: ${String(error)}`,
      timedOut: true,
      source: adapter.name,
    };
  }
}

function eventPayload(raw: GeminiHookEvent): unknown {
  if (raw.hook_event_name === 'BeforeTool' || raw.hook_event_name === 'AfterTool') {
    return raw.tool_input ?? {};
  }
  if (raw.hook_event_name === 'BeforeAgent' || raw.hook_event_name === 'AfterAgent') {
    return { prompt: raw.prompt, prompt_response: raw.prompt_response };
  }
  if (raw.hook_event_name === 'BeforeModel' || raw.hook_event_name === 'AfterModel' || raw.hook_event_name === 'BeforeToolSelection') {
    return { llm_request: raw.llm_request, llm_response: raw.llm_response };
  }
  if (raw.hook_event_name === 'Notification') {
    return { notification_type: raw.notification_type, message: raw.message, details: raw.details };
  }
  return raw;
}

function buildAction(raw: GeminiHookEvent, redactedPayload: unknown): string {
  const command = extractCommand(redactedPayload);
  if (command) return `Gemini CLI ${raw.tool_name || 'tool'}: ${truncate(command, 140)}`;
  if (raw.hook_event_name === 'BeforeAgent') return 'Gemini CLI user prompt submitted';
  if (raw.hook_event_name === 'AfterAgent') return 'Gemini CLI agent response completed';
  return `Gemini CLI ${raw.hook_event_name}: ${raw.tool_name || 'session'}`;
}

function buildDescription(raw: GeminiHookEvent, preview: string): string {
  if (raw.hook_event_name === 'BeforeTool') return `Gemini CLI is about to run ${raw.tool_name || 'a tool'}.\n\nArguments preview:\n${preview}`;
  if (raw.hook_event_name === 'AfterTool') return `Gemini CLI completed ${raw.tool_name || 'a tool'}.`;
  if (raw.hook_event_name === 'BeforeAgent') return truncate(String(raw.prompt || preview), 800);
  return `Gemini CLI hook event ${raw.hook_event_name}.`;
}

function extractCommand(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  const command = input.command ?? input.CommandLine ?? input.cmd ?? input.script;
  return typeof command === 'string' ? command : undefined;
}

function estimateFileCount(input: unknown): number {
  const text = stableStringify(input);
  const matches = text.match(/(?:[A-Za-z]:\\|\.{0,2}\/)[^"'\s]+/g);
  return matches ? Math.min(matches.length, 999) : 0;
}

function geminiWorkspaceName(cwd: string): string {
  const normalized = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
  return normalized.at(-1) || 'Gemini CLI Project';
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}
