import { loadCredentials } from '../auth/credentials.js';
import { getAuthHeaders } from '../utils/auth.js';
import { pollForDecision } from '../utils/poll.js';
import { sseWaitForDecision } from '../utils/sse.js';
import type { CodexApprovalDecision, OrbiterCodexApprovalRequest } from './types.js';

export interface CreatedCodexApproval {
  approvalId?: string;
  status?: string;
  raw: unknown;
}

export function getCodexServerUrl(override?: string): string {
  if (override) return override;
  if (process.env.ORBITER_SERVER_URL) return process.env.ORBITER_SERVER_URL;
  const credentials = loadCredentials();
  return credentials?.backend_url || 'https://api.orbiterdev.ai';
}

export async function createCodexApproval(request: OrbiterCodexApprovalRequest, serverUrlOverride?: string): Promise<CreatedCodexApproval> {
  const serverUrl = getCodexServerUrl(serverUrlOverride);
  const response = await fetch(`${serverUrl}/api/v1/approvals`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(request),
  });

  const text = await response.text();
  const parsed = parseJson(text);

  if (!response.ok) {
    throw new Error(`Orbiter approval create failed with ${response.status}: ${text}`);
  }

  const data = getRecord(parsed)?.data;
  const approval = getRecord(data);
  return {
    approvalId: stringValue(approval?.id),
    status: stringValue(approval?.status),
    raw: parsed,
  };
}

export async function waitForCodexDecision(approvalId: string, timeoutSeconds = 300, serverUrlOverride?: string): Promise<CodexApprovalDecision> {
  const serverUrl = getCodexServerUrl(serverUrlOverride);
  try {
    const decision = await sseWaitForDecision(serverUrl, approvalId, timeoutSeconds);
    return {
      status: normalizeDecisionStatus(decision.status),
      notes: decision.notes,
      timedOut: decision.timedOut,
      approvalId,
      source: 'http',
    };
  } catch {
    const decision = await pollForDecision(serverUrl, approvalId, timeoutSeconds);
    return {
      status: normalizeDecisionStatus(decision.status),
      notes: decision.notes,
      timedOut: decision.timedOut,
      approvalId,
      source: 'http',
    };
  }
}

export async function postCodexJson(path: string, body: unknown): Promise<unknown> {
  const serverUrl = getCodexServerUrl();
  const response = await fetch(`${serverUrl}${path}`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(body),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Orbiter POST ${path} failed with ${response.status}: ${text}`);
  }
  return parseJson(text);
}

function normalizeDecisionStatus(status: string | undefined): CodexApprovalDecision['status'] {
  if (status === 'approved' || status === 'rejected' || status === 'timeout' || status === 'pending') return status;
  return 'timeout';
}

function parseJson(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (value && typeof value === 'object' && 'String' in value) {
    const nullable = value as { String?: unknown };
    return typeof nullable.String === 'string' ? nullable.String : undefined;
  }
  return undefined;
}
