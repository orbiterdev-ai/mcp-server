import { randomUUID } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { isRecord, stableStringify, truncate } from './codex/json.js';

export type HookCaptureProvider = 'codex' | 'antigravity' | 'gemini' | 'claude-code';
export type HookCaptureAdapter = 'mock' | 'file' | 'http' | string;

export interface HookCaptureReceiptInput {
  captureDir: string;
  provider: HookCaptureProvider;
  event: string;
  rawPayload: unknown;
  normalizedApprovalRequest?: unknown;
  hookOutput: unknown;
  stdoutReturnedToIde: string;
  adapter?: HookCaptureAdapter;
  decisionScenario?: string;
  commandMetadata?: Record<string, unknown>;
  secretScanPassed?: boolean;
}

export interface HookCaptureReceipt {
  provider: HookCaptureProvider;
  event: string;
  captured_at: string;
  adapter: string;
  decision_scenario: string;
  raw_payload_redacted: unknown;
  normalized_approval_request: unknown;
  hook_output: unknown;
  stdout_returned_to_ide: string;
  backend_used: boolean;
  secret_scan_passed: boolean;
  command_metadata?: Record<string, unknown>;
}

export interface HookCaptureWriteResult {
  receiptPath: string;
  receipt: HookCaptureReceipt;
}

const SECRET_KEY_PATTERN = /(?:token|secret|password|passwd|api[_-]?key|authorization|credential|private[_-]?key|bearer|auth)/i;
const CREDENTIAL_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/i,
  /\bsk-[A-Za-z0-9_-]{20,}\b/i,
  /\bghp_[A-Za-z0-9_]{20,}\b/i,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/i,
  /\bAIza[0-9A-Za-z_-]{20,}\b/i,
  /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/i,
  /\b(?:token|secret|password|api[_-]?key|authorization|credential)=["']?[^"'\s&]{8,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/i,
];

export interface OfflineCaptureDefaultsTarget {
  captureDir?: string;
  adapter?: 'mock' | 'file' | 'http';
  mockDecision?: string;
  serverUrl?: string;
}

export function applyOfflineCaptureDefaults(options: OfflineCaptureDefaultsTarget): void {
  if (!options.captureDir) return;
  if (!options.adapter || options.adapter === 'http') options.adapter = 'mock';
  if (options.adapter === 'mock' && !options.mockDecision) options.mockDecision = 'rejected';
  delete options.serverUrl;
  process.env.ORBITER_CODEX_REPORT_TELEMETRY = 'false';
  process.env.ORBITER_ANTIGRAVITY_REPORT_TELEMETRY = 'false';
}

export function scanHookCaptureSecrets(value: unknown): boolean {
  return !containsCredentialLikeValue(value);
}

export async function writeHookCaptureReceipt(input: HookCaptureReceiptInput): Promise<HookCaptureWriteResult> {
  const capturedAt = new Date().toISOString();
  const eventSegment = safePathSegment(input.event || 'unknown');
  const providerSegment = safePathSegment(input.provider);
  const receiptDir = path.join(input.captureDir, providerSegment, eventSegment);
  const receiptPath = path.join(receiptDir, `${capturedAt.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.json`);
  const secretScanPassed = input.secretScanPassed ?? scanHookCaptureSecrets(input.rawPayload);
  const receipt: HookCaptureReceipt = {
    provider: input.provider,
    event: input.event || 'unknown',
    captured_at: capturedAt,
    adapter: input.adapter || 'mock',
    decision_scenario: input.decisionScenario || 'unspecified',
    raw_payload_redacted: redactForCapture(input.rawPayload),
    normalized_approval_request: input.normalizedApprovalRequest ? redactForCapture(input.normalizedApprovalRequest) : {},
    hook_output: redactForCapture(input.hookOutput),
    stdout_returned_to_ide: redactStringForCapture(input.stdoutReturnedToIde),
    backend_used: input.adapter === 'http',
    secret_scan_passed: secretScanPassed,
    ...(input.commandMetadata ? { command_metadata: redactForCapture(input.commandMetadata) as Record<string, unknown> } : {}),
  };

  await mkdir(receiptDir, { recursive: true });
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return { receiptPath, receipt };
}

export function captureFailClosedOutput(provider: HookCaptureProvider, event: string, reason: string): unknown {
  if (provider === 'codex') {
    if (event === 'PermissionRequest') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: {
            behavior: 'deny',
            message: reason,
          },
        },
      };
    }
    if (event === 'PreToolUse') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      };
    }
    return {};
  }

  if (provider === 'antigravity') {
    if (event === 'PreToolUse') return { decision: 'deny', reason };
    if (event === 'Stop') return { decision: '', reason };
    return {};
  }

  if (provider === 'gemini') {
    if (event === 'BeforeTool') return { decision: 'deny', reason };
    return {};
  }

  if (event === 'PermissionRequest') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: reason },
      },
    };
  }
  if (event === 'PreToolUse') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    };
  }
  return {};
}

export function captureEventFromPayload(value: unknown, fallback = 'unknown'): string {
  if (isRecord(value) && typeof value.hook_event_name === 'string' && value.hook_event_name.length > 0) {
    return value.hook_event_name;
  }
  return fallback;
}

function redactForCapture(value: unknown): unknown {
  if (typeof value === 'string') return redactStringForCapture(value);
  if (Array.isArray(value)) return value.map((item) => redactForCapture(item));
  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        output[key] = '[REDACTED:secret-field]';
      } else {
        output[key] = redactForCapture(item);
      }
    }
    return output;
  }
  return value;
}

function redactStringForCapture(value: string): string {
  let output = value;
  for (const pattern of CREDENTIAL_PATTERNS) {
    output = output.replace(pattern, '[REDACTED:credential]');
  }
  output = output.replace(/\b(Authorization:\s*)[^\r\n]+/gi, '$1[REDACTED:credential]');
  output = output.replace(/\b([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s"']+/gi, '$1[REDACTED:user]');
  output = output.replace(/\b([A-Za-z]:\\Users\\)[^\\\s"']+/gi, '$1[REDACTED:user]');
  output = output.replace(/\b(\/Users\/)[^/\s"']+/g, '$1[REDACTED:user]');
  return output;
}

function containsCredentialLikeValue(value: unknown): boolean {
  if (typeof value === 'string') return stringContainsCredentialLikeValue(value);
  if (Array.isArray(value)) return value.some((item) => containsCredentialLikeValue(item));
  if (isRecord(value)) {
    return Object.entries(value).some(([key, item]) => {
      if (SECRET_KEY_PATTERN.test(key) && primitiveHasContent(item)) return true;
      return containsCredentialLikeValue(item);
    });
  }
  return false;
}

function stringContainsCredentialLikeValue(value: string): boolean {
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value))) return true;
  const candidates = value.match(/[A-Za-z0-9_+=-]{40,}/g) || [];
  return candidates.some((candidate) => entropy(candidate) >= 4.6 && /[A-Za-z]/.test(candidate) && /\d/.test(candidate));
}

function primitiveHasContent(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return false;
}

function entropy(value: string): number {
  if (!value.length) return 0;
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) || 0) + 1);
  let result = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    result -= probability * Math.log2(probability);
  }
  return result;
}

function safePathSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]/g, '_').replace(/_+/g, '_').slice(0, 80);
  return sanitized || 'unknown';
}

export function rawPayloadForParseError(raw: string, error: unknown): Record<string, unknown> {
  return {
    parse_error: String(error),
    raw_preview: truncate(raw, 1200),
  };
}
