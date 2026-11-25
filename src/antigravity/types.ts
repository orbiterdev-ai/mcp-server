import { z } from 'zod';
import type { CodexApprovalDecision, CodexApprovalStatus, OrbiterCodexApprovalRequest } from '../codex/types.js';

export const ANTIGRAVITY_HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PreInvocation',
  'PostInvocation',
  'Stop',
] as const;

export type AntigravityHookEventName = typeof ANTIGRAVITY_HOOK_EVENTS[number];
export type AntigravityRiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type AntigravityHookProfile = 'observe' | 'blocking' | 'strict';
export type AntigravityApprovalFallback = 'deny' | 'force_ask';
export type AntigravityApprovalAdapterName = 'mock' | 'file' | 'http';
export type AntigravityApprovalStatus = CodexApprovalStatus;
export type AntigravityApprovalDecision = CodexApprovalDecision;
export type OrbiterAntigravityApprovalRequest = OrbiterCodexApprovalRequest;

const commonInputSchema = z.object({
  conversationId: z.string().optional(),
  workspacePaths: z.array(z.string()).default([]),
  transcriptPath: z.string().optional(),
  artifactDirectoryPath: z.string().optional(),
}).passthrough();

export const antigravityToolCallSchema = z.object({
  name: z.string().min(1),
  args: z.record(z.unknown()).default({}),
}).passthrough();

export const antigravityPreToolUseInputSchema = commonInputSchema.extend({
  toolCall: antigravityToolCallSchema,
  stepIdx: z.coerce.number().int().default(-1),
}).passthrough();

export const antigravityPostToolUseInputSchema = commonInputSchema.extend({
  stepIdx: z.coerce.number().int().default(-1),
  error: z.string().optional().default(''),
}).passthrough();

export const antigravityInvocationInputSchema = commonInputSchema.extend({
  invocationNum: z.coerce.number().int().default(-1),
  initialNumSteps: z.coerce.number().int().default(-1),
}).passthrough();

export const antigravityStopInputSchema = commonInputSchema.extend({
  executionNum: z.coerce.number().int().default(-1),
  terminationReason: z.string().optional().default('unknown'),
  error: z.string().optional().default(''),
  fullyIdle: z.boolean().optional().default(false),
}).passthrough();

export type AntigravityPreToolUseInput = z.infer<typeof antigravityPreToolUseInputSchema>;
export type AntigravityPostToolUseInput = z.infer<typeof antigravityPostToolUseInputSchema>;
export type AntigravityInvocationInput = z.infer<typeof antigravityInvocationInputSchema>;
export type AntigravityStopInput = z.infer<typeof antigravityStopInputSchema>;

export type AntigravityHookInput =
  | AntigravityPreToolUseInput
  | AntigravityPostToolUseInput
  | AntigravityInvocationInput
  | AntigravityStopInput;

export interface AntigravityRiskEvaluation {
  level: AntigravityRiskLevel;
  reasons: string[];
  flags: string[];
}

export interface AntigravityMetadata {
  source_ide: 'antigravity';
  source_runtime: 'antigravity_2';
  antigravity_conversation_id: string;
  antigravity_step_idx: number;
  antigravity_tool_name: string;
  antigravity_hook_event_name: AntigravityHookEventName;
  antigravity_workspace_paths: string[];
  antigravity_transcript_path_present: boolean;
  antigravity_artifact_directory_present: boolean;
  antigravity_tool_input_hash: string;
  antigravity_tool_input_preview: string;
  antigravity_idempotency_key: string;
}

export interface NormalizedAntigravityEvent {
  raw: AntigravityPreToolUseInput;
  metadata: AntigravityMetadata;
  approval: OrbiterAntigravityApprovalRequest;
  risk: AntigravityRiskEvaluation;
  isOrbiterLoop: boolean;
  requiresApproval: boolean;
}

export interface AntigravityHookHandleOptions {
  eventName?: AntigravityHookEventName;
  adapter?: AntigravityApprovalAdapterName;
  mockDecision?: AntigravityApprovalStatus;
  timeoutSeconds?: number;
  serverUrl?: string;
  profile?: AntigravityHookProfile;
  fallback?: AntigravityApprovalFallback;
  /** 'ask' (default): critical routes to the phone; 'deny': local hard-deny (pre-2026-07). */
  criticalMode?: 'ask' | 'deny';
}

export interface AntigravityHookHandleResult {
  output: unknown;
  normalized?: NormalizedAntigravityEvent;
  decision?: AntigravityApprovalDecision;
}

export interface AntigravityPreToolUseOutput {
  decision: 'allow' | 'deny' | 'ask' | 'force_ask';
  reason?: string;
  permissionOverrides?: string[];
}
