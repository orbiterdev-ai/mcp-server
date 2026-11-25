export type CodexHookEventName =
  | 'SessionStart'
  | 'SubagentStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PermissionRequest'
  | 'PostToolUse'
  | 'PreCompact'
  | 'PostCompact'
  | 'SubagentStop'
  | 'Stop';

export type CodexRiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type CodexApprovalStatus = 'approved' | 'rejected' | 'timeout' | 'pending';
export type CodexSourceRuntime = 'codex_app' | 'codex_cli' | 'codex_ide' | 'codex_sdk' | 'codex_app_server';

export interface CodexHookEvent {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name: CodexHookEventName;
  model?: string;
  turn_id?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  prompt?: string;
  stop_reason?: string;
  [key: string]: unknown;
}

export interface CodexMetadata {
  source_ide: 'codex';
  source_runtime: CodexSourceRuntime;
  codex_session_id: string;
  codex_turn_id: string;
  codex_tool_use_id: string;
  codex_tool_name: string;
  codex_hook_event_name: CodexHookEventName;
  codex_model: string;
  codex_cwd: string;
  codex_transcript_path_present: boolean;
  codex_tool_input_hash: string;
  codex_tool_input_preview: string;
  codex_idempotency_key: string;
}

export interface OrbiterCodexApprovalRequest {
  action: string;
  description: string;
  diff_summary: string;
  file_count: number;
  risk_level: CodexRiskLevel;
  source_ide: string;
  source_extension_version: string;
  workspace_name: string;
  thoughts?: string;
  mcp_permission_id?: string;
  tool_name?: string;
  tool_input_json?: string;
  auto_approve?: boolean;
  codex_session_id?: string;
  codex_turn_id?: string;
  codex_tool_use_id?: string;
  codex_hook_event_name?: string;
  codex_tool_input_hash?: string;
  codex_tool_input_preview?: string;
  codex_idempotency_key?: string;
}

export interface NormalizedCodexEvent {
  raw: CodexHookEvent;
  metadata: CodexMetadata;
  approval: OrbiterCodexApprovalRequest;
  risk: CodexRiskLevel;
  isOrbiterLoop: boolean;
}

export interface CodexApprovalDecision {
  status: CodexApprovalStatus;
  notes?: string;
  approvalId?: string;
  timedOut?: boolean;
  source?: 'mock' | 'file' | 'http' | 'cache';
}

export interface CodexApprovalAdapter {
  name: 'mock' | 'file' | 'http';
  requestApproval(request: OrbiterCodexApprovalRequest): Promise<CodexApprovalDecision>;
}

export interface CodexHookHandleOptions {
  adapter?: 'mock' | 'file' | 'http';
  mockDecision?: CodexApprovalStatus;
  timeoutSeconds?: number;
  serverUrl?: string;
  /**
   * What to do when policy classifies an action as critical.
   * 'ask' (default): route to the phone like any gated action - the phone stays the only
   * approver, matching the Claude Code surfaces and the public product contract.
   * 'deny': hard-deny locally without asking (the pre-2026-07 behavior).
   */
  criticalMode?: 'ask' | 'deny';
  /**
   * What to do when the approval flow cannot complete (adapter error, timeout, pending).
   * An explicit rejection always denies regardless of this setting.
   * 'deny' (default): fail closed.
   * 'allow': fail open - the action proceeds without a recorded decision. Only for
   * environments that prefer availability over gating (mirrors Claude Code's native-prompt
   * fallthrough, which this surface cannot express).
   */
  fallback?: 'deny' | 'allow';
}

export interface CodexHookHandleResult {
  output: unknown;
  normalized?: NormalizedCodexEvent;
  decision?: CodexApprovalDecision;
}

export interface CodexJsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}
