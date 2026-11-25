import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type {
  CodexApprovalAdapter,
  CodexApprovalDecision,
  CodexApprovalStatus,
  OrbiterCodexApprovalRequest,
} from './types.js';
import { createCodexApproval, waitForCodexDecision } from './approvalClient.js';

/**
 * Explicit per-call options. These take precedence over the corresponding environment
 * variables, which remain only as process-level defaults. Callers (the hook handlers)
 * pass their parsed CLI options here instead of mutating process.env - hidden global
 * state that leaked earlier calls' options into later ones in long-lived processes.
 */
export interface CodexApprovalAdapterOptions {
  serverUrl?: string;
  timeoutSeconds?: number;
  mockDecision?: CodexApprovalStatus;
}

export function createCodexApprovalAdapter(
  name: 'mock' | 'file' | 'http' = adapterFromEnv(),
  options: CodexApprovalAdapterOptions = {},
): CodexApprovalAdapter {
  if (name === 'mock') return new MockCodexApprovalAdapter(options.mockDecision ?? statusFromEnv());
  if (name === 'file') return new FileCodexApprovalAdapter(options.timeoutSeconds);
  return new HttpCodexApprovalAdapter(options);
}

export class MockCodexApprovalAdapter implements CodexApprovalAdapter {
  readonly name = 'mock' as const;

  constructor(private readonly decision: CodexApprovalStatus = 'approved') {}

  async requestApproval(request: OrbiterCodexApprovalRequest): Promise<CodexApprovalDecision> {
    if (request.auto_approve) {
      return { status: 'approved', notes: 'Auto-approved by mock adapter', approvalId: 'mock-auto', source: 'mock' };
    }
    return {
      status: this.decision,
      notes: `Mock adapter returned ${this.decision}`,
      approvalId: `mock-${request.codex_idempotency_key || 'approval'}`,
      timedOut: this.decision === 'timeout',
      source: 'mock',
    };
  }
}

export class HttpCodexApprovalAdapter implements CodexApprovalAdapter {
  readonly name = 'http' as const;

  constructor(private readonly options: CodexApprovalAdapterOptions = {}) {}

  async requestApproval(request: OrbiterCodexApprovalRequest): Promise<CodexApprovalDecision> {
    const created = await createCodexApproval(request, this.options.serverUrl);
    if (created.status === 'approved') {
      return { status: 'approved', approvalId: created.approvalId, notes: 'Auto-approved by Orbiter backend', source: 'http' };
    }
    if (!created.approvalId) {
      return { status: 'timeout', notes: 'Orbiter backend did not return approval id', timedOut: true, source: 'http' };
    }
    const timeoutSeconds = this.options.timeoutSeconds ?? Number(process.env.ORBITER_CODEX_TIMEOUT_SECONDS || 300);
    return waitForCodexDecision(created.approvalId, timeoutSeconds, this.options.serverUrl);
  }
}

export class FileCodexApprovalAdapter implements CodexApprovalAdapter {
  readonly name = 'file' as const;
  private readonly dir = path.resolve(process.env.ORBITER_CODEX_FILE_APPROVAL_DIR || path.join(process.cwd(), '.codex-orbiter', 'approvals'));

  constructor(private readonly timeoutSecondsOption?: number) {}

  async requestApproval(request: OrbiterCodexApprovalRequest): Promise<CodexApprovalDecision> {
    fs.mkdirSync(this.dir, { recursive: true });
    const approvalId = randomUUID();
    const approvalPath = path.join(this.dir, `${approvalId}.json`);
    fs.writeFileSync(approvalPath, JSON.stringify({ id: approvalId, status: 'pending', request }, null, 2));

    const timeoutSeconds = this.timeoutSecondsOption ?? Number(process.env.ORBITER_CODEX_FILE_TIMEOUT_SECONDS || 300);
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      const current = readDecision(approvalPath);
      if (current === 'approved' || current === 'rejected') {
        return { status: current, approvalId, notes: `Decision read from ${approvalPath}`, source: 'file' };
      }
      await sleep(1000);
    }
    return { status: 'timeout', approvalId, timedOut: true, notes: `No file decision within ${timeoutSeconds}s at ${approvalPath}`, source: 'file' };
  }
}

function readDecision(approvalPath: string): CodexApprovalStatus | undefined {
  if (!fs.existsSync(approvalPath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(approvalPath, 'utf8')) as { status?: CodexApprovalStatus };
    return parsed.status;
  } catch {
    return undefined;
  }
}

function adapterFromEnv(): 'mock' | 'file' | 'http' {
  const value = process.env.ORBITER_CODEX_APPROVAL_ADAPTER;
  if (value === 'mock' || value === 'file' || value === 'http') return value;
  return 'http';
}

function statusFromEnv(): CodexApprovalStatus {
  const value = process.env.ORBITER_CODEX_MOCK_DECISION;
  if (value === 'approved' || value === 'rejected' || value === 'timeout' || value === 'pending') return value;
  return 'approved';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
