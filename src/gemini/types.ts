import type { CodexApprovalDecision, CodexApprovalStatus, CodexRiskLevel, OrbiterCodexApprovalRequest } from '../codex/types.js';

export const GEMINI_HOOK_EVENTS = [
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
] as const;

export type GeminiHookEventName = typeof GEMINI_HOOK_EVENTS[number];
export type GeminiConfigScope = 'workspace' | 'global';
export type GeminiHookProfile = 'minimal' | 'guarded' | 'full';
export type GeminiApprovalAdapterName = 'mock' | 'file' | 'http';
export type GeminiApprovalStatus = CodexApprovalStatus;
export type GeminiApprovalDecision = CodexApprovalDecision;
export type GeminiRiskLevel = CodexRiskLevel;
export type OrbiterGeminiApprovalRequest = OrbiterCodexApprovalRequest;

export interface GeminiHookEvent {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name: GeminiHookEventName;
  timestamp?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  mcp_context?: unknown;
  original_request_name?: string;
  prompt?: string;
  prompt_response?: string;
  stop_hook_active?: boolean;
  llm_request?: unknown;
  llm_response?: unknown;
  source?: string;
  reason?: string;
  notification_type?: string;
  message?: string;
  details?: unknown;
  trigger?: string;
  [key: string]: unknown;
}

export interface GeminiMetadata {
  source_ide: 'gemini_cli';
  source_runtime: 'gemini_cli_hooks';
  gemini_session_id: string;
  gemini_hook_event_name: GeminiHookEventName;
  gemini_tool_name: string;
  gemini_cwd: string;
  gemini_transcript_path_present: boolean;
  gemini_tool_input_hash: string;
  gemini_tool_input_preview: string;
  gemini_idempotency_key: string;
}

export interface NormalizedGeminiEvent {
  raw: GeminiHookEvent;
  metadata: GeminiMetadata;
  approval: OrbiterGeminiApprovalRequest;
  risk: GeminiRiskLevel;
  isOrbiterLoop: boolean;
}

export interface GeminiHookHandleOptions {
  eventName?: GeminiHookEventName;
  adapter?: GeminiApprovalAdapterName;
  mockDecision?: GeminiApprovalStatus;
  timeoutSeconds?: number;
  serverUrl?: string;
  /** 'ask' (default): critical routes to the phone; 'deny': local hard-deny (pre-2026-07). */
  criticalMode?: 'ask' | 'deny';
  /** Incomplete-decision policy (timeout/adapter failure). Explicit rejection always denies. */
  fallback?: 'deny' | 'allow';
}

export interface GeminiHookHandleResult {
  output: unknown;
  normalized?: NormalizedGeminiEvent;
  decision?: GeminiApprovalDecision;
}

