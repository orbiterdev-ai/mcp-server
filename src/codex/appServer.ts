import type {
  CodexApprovalDecision,
  CodexApprovalStatus,
  CodexJsonRpcRequest,
  NormalizedCodexEvent,
} from './types.js';
import { createCodexApprovalAdapter } from './approvalAdapters.js';
import { normalizeCodexHookEvent } from './hooks.js';
import { isRecord, truncate } from './json.js';
import { readCachedCodexDecision, writeCachedCodexDecision } from './idempotency.js';
import { mcpComponentVersion } from '../version.js';

export type CodexAppServerDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';
export type CodexAppServerApprovalKind = 'command' | 'file';
export type CodexAppServerAcceptScope = 'once' | 'session';

export interface CodexAppServerApprovalOptions {
  adapter?: 'mock' | 'file' | 'http';
  mockDecision?: CodexApprovalStatus;
  timeoutSeconds?: number;
  serverUrl?: string;
  acceptScope?: CodexAppServerAcceptScope;
  useCache?: boolean;
}

export interface CodexAppServerApprovalResult {
  appServerDecision: CodexAppServerDecision;
  approvalDecision: CodexApprovalDecision;
  normalized: NormalizedCodexEvent;
}

const appServerApprovalMethods = [
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
];

export function isCodexAppServerApprovalRequest(request: CodexJsonRpcRequest): boolean {
  return appServerApprovalMethods.includes(request.method);
}

export function normalizeCodexAppServerApprovalRequest(request: CodexJsonRpcRequest): NormalizedCodexEvent {
  if (!isCodexAppServerApprovalRequest(request)) {
    throw new Error(`Unsupported Codex App Server approval method: ${request.method}`);
  }

  const params = request.params || {};
  const kind: CodexAppServerApprovalKind = request.method.includes('fileChange') ? 'file' : 'command';
  const command = extractCommand(params) || request.method;
  const files = extractFiles(params);
  const reason = stringParam(params, 'reason') || stringParam(params, 'description') || '';
  const cwd = stringParam(params, 'cwd') || process.cwd();
  const sessionId = stringParam(params, 'threadId') || stringParam(params, 'sessionId') || 'app-server-thread';
  const turnId = stringParam(params, 'turnId') || 'app-server-turn';
  const toolUseId = stringParam(params, 'itemId') || String(request.id ?? 'app-server-item');

  const normalized = normalizeCodexHookEvent({
    hook_event_name: 'PermissionRequest',
    session_id: sessionId,
    turn_id: turnId,
    tool_use_id: toolUseId,
    tool_name: kind === 'file' ? 'codex_app_server_file_change' : 'codex_app_server_command',
    cwd,
    model: 'codex-app-server',
    tool_input: {
      app_server_method: request.method,
      app_server_request_id: request.id ?? null,
      approval_kind: kind,
      ...params,
    },
  });

  const fileCount = kind === 'file' ? files.length : 0;

  normalized.approval.action = kind === 'command'
    ? `Codex App Server command: ${truncate(command, 120)}`
    : `Codex App Server file change: ${fileCount} file${fileCount === 1 ? '' : 's'}`;
  normalized.approval.description = reason
    ? `Codex App Server requests approval. Reason: ${truncate(reason, 500)}`
    : `Codex App Server requests approval for a ${kind === 'command' ? 'command' : 'file change'}.`;
  // ORB-32: Keep concise file list for file-change approvals; omit duplicate JSON preview for commands.
  normalized.approval.diff_summary = kind === 'file' && files.length > 0
    ? truncate(files.slice(0, 20).join('\n'), 1800)
    : '';
  normalized.approval.file_count = fileCount;
  normalized.approval.source_extension_version = mcpComponentVersion('codex-app-server');
  normalized.approval.tool_name = kind === 'file' ? 'codex_app_server_file_change' : 'codex_app_server_command';
  normalized.approval.tool_input_json = JSON.stringify({
    payload_mode: 'redacted_preview',
    preview: normalized.metadata.codex_tool_input_preview,
    hash: normalized.metadata.codex_tool_input_hash,
    codex: {
      session_id: normalized.metadata.codex_session_id,
      turn_id: normalized.metadata.codex_turn_id,
      tool_use_id: normalized.metadata.codex_tool_use_id,
      hook_event_name: normalized.metadata.codex_hook_event_name,
      model: normalized.metadata.codex_model,
    },
    app_server: {
      method: request.method,
      request_id: request.id ?? null,
      approval_kind: kind,
    },
  }, null, 2);

  return normalized;
}

export async function requestCodexAppServerApproval(
  request: CodexJsonRpcRequest,
  options: CodexAppServerApprovalOptions = {},
): Promise<CodexAppServerApprovalResult> {
  if (options.serverUrl) process.env.ORBITER_SERVER_URL = options.serverUrl;
  if (options.timeoutSeconds) process.env.ORBITER_CODEX_TIMEOUT_SECONDS = String(options.timeoutSeconds);
  if (options.mockDecision) process.env.ORBITER_CODEX_MOCK_DECISION = options.mockDecision;

  const normalized = normalizeCodexAppServerApprovalRequest(request);
  const adapter = createCodexApprovalAdapter(options.adapter);
  const useCache = adapter.name !== 'mock' && options.useCache !== false;
  const cached = useCache ? readCachedCodexDecision(normalized.metadata.codex_idempotency_key) : undefined;
  const approvalDecision = cached || await adapter.requestApproval(normalized.approval).catch((error) => ({
    status: 'timeout' as const,
    notes: `Orbiter Codex App Server approval adapter failed: ${String(error)}`,
    timedOut: true,
    source: adapter.name,
  }));

  if (!cached && useCache) {
    writeCachedCodexDecision(normalized.metadata.codex_idempotency_key, approvalDecision);
  }

  return {
    appServerDecision: mapCodexAppServerDecision(approvalDecision, options.acceptScope),
    approvalDecision,
    normalized,
  };
}

export function mapCodexAppServerDecision(
  decision: CodexApprovalDecision,
  acceptScope: CodexAppServerAcceptScope = codexAppServerAcceptScopeFromEnv(),
): CodexAppServerDecision {
  if (decision.status === 'approved') return acceptScope === 'session' ? 'acceptForSession' : 'accept';
  if (decision.status === 'rejected') return 'decline';
  return 'cancel';
}

export function assertCodexJsonRpcRequest(value: unknown): CodexJsonRpcRequest {
  if (!isRecord(value) || typeof value.method !== 'string') {
    throw new Error('Codex App Server fixture must be a JSON-RPC request with a method');
  }
  if (typeof value.jsonrpc !== 'undefined' && value.jsonrpc !== '2.0') {
    throw new Error('Codex App Server JSON-RPC version must be 2.0 when present');
  }
  return {
    ...value,
    jsonrpc: '2.0',
  } as CodexJsonRpcRequest;
}

function codexAppServerAcceptScopeFromEnv(): CodexAppServerAcceptScope {
  return process.env.ORBITER_CODEX_APP_SERVER_ACCEPT_SCOPE === 'session' ? 'session' : 'once';
}

function extractCommand(params: Record<string, unknown>): string | undefined {
  const command = params.command ?? params.cmd ?? params.script;
  if (typeof command === 'string') return command;
  if (Array.isArray(params.argv)) return params.argv.map((part) => String(part)).join(' ');
  return undefined;
}

function extractFiles(params: Record<string, unknown>): string[] {
  const files = params.files ?? params.paths ?? params.file_paths;
  if (Array.isArray(files)) return files.filter((file): file is string => typeof file === 'string');
  const file = params.file ?? params.path ?? params.file_path;
  return typeof file === 'string' ? [file] : [];
}

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
