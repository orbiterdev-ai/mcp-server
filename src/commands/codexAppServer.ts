import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import readline from 'readline';
import type { Writable } from 'stream';
import type { CodexApprovalStatus, CodexJsonRpcRequest } from '../codex/types.js';
import {
  assertCodexJsonRpcRequest,
  isCodexAppServerApprovalRequest,
  requestCodexAppServerApproval,
  type CodexAppServerAcceptScope,
  type CodexAppServerApprovalOptions,
} from '../codex/appServer.js';

interface CodexAppServerCommandOptions extends CodexAppServerApprovalOptions {
  fixturePath?: string;
  command?: string;
  commandArgs: string[];
  dryRun?: boolean;
}

export async function handleCodexAppServerCommand(args: string[]): Promise<void> {
  process['env'].ORBITER_CREDENTIAL_PROFILE ||= 'codex';
  process['env'].ORBITER_IDE_NAME ||= 'Codex';
  const options = parseCodexAppServerArgs(args);

  if (options.fixturePath) {
    const fixture = assertCodexJsonRpcRequest(JSON.parse(await readFile(resolve(options.fixturePath), 'utf8')) as unknown);
    const result = await requestCodexAppServerApproval(fixture, options);
    process.stdout.write(`${JSON.stringify({
      success: true,
      decision: result.appServerDecision,
      response: responseForDecision(fixture, result.appServerDecision),
      approval: {
        status: result.approvalDecision.status,
        source: result.approvalDecision.source,
        timedOut: Boolean(result.approvalDecision.timedOut),
      },
      normalized: {
        action: result.normalized.approval.action,
        risk: result.normalized.approval.risk_level,
        fileCount: result.normalized.approval.file_count,
      },
    }, null, 2)}\n`);
    return;
  }

  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({
      success: true,
      action: 'codex-app-server',
      command: options.command || 'codex',
      args: options.commandArgs.length > 0 ? options.commandArgs : ['app-server'],
      adapter: options.adapter || 'http',
      acceptScope: options.acceptScope || 'once',
    }, null, 2)}\n`);
    return;
  }

  await bridgeCodexAppServer(options);
}

function bridgeCodexAppServer(options: CodexAppServerCommandOptions): Promise<void> {
  const command = options.command || 'codex';
  const commandArgs = options.commandArgs.length > 0 ? options.commandArgs : ['app-server'];
  const child = spawn(command, commandArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ORBITER_CREDENTIAL_PROFILE: process['env'].ORBITER_CREDENTIAL_PROFILE || 'codex',
      ORBITER_IDE_NAME: process['env'].ORBITER_IDE_NAME || 'Codex',
      ...process.env,
      ORBITER_CODEX_APPROVAL_ADAPTER: options.adapter || process.env.ORBITER_CODEX_APPROVAL_ADAPTER || 'http',
      ORBITER_CODEX_MOCK_DECISION: options.mockDecision || process.env.ORBITER_CODEX_MOCK_DECISION || '',
      ORBITER_CODEX_TIMEOUT_SECONDS: options.timeoutSeconds
        ? String(options.timeoutSeconds)
        : process.env.ORBITER_CODEX_TIMEOUT_SECONDS || '',
      ORBITER_SERVER_URL: options.serverUrl || process.env.ORBITER_SERVER_URL || '',
      ORBITER_CODEX_APP_SERVER_ACCEPT_SCOPE: options.acceptScope || process.env.ORBITER_CODEX_APP_SERVER_ACCEPT_SCOPE || 'once',
    },
  });

  process.stdin.pipe(child.stdin);
  child.stderr.pipe(process.stderr);

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    void handleAppServerLine(child, line, options);
  });

  return new Promise((resolvePromise, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code && code !== 0) {
        reject(new Error(`codex app-server exited with code ${code}`));
        return;
      }
      resolvePromise();
    });
  });
}

async function handleAppServerLine(
  child: ChildProcessWithoutNullStreams,
  line: string,
  options: CodexAppServerCommandOptions,
): Promise<void> {
  const parsed = parseJsonLine(line);
  if (!parsed) {
    process.stdout.write(`${line}\n`);
    return;
  }

  let request: CodexJsonRpcRequest | undefined;
  try {
    request = assertCodexJsonRpcRequest(parsed);
  } catch {
    process.stdout.write(`${line}\n`);
    return;
  }

  if (!isCodexAppServerApprovalRequest(request) || typeof request.id === 'undefined') {
    process.stdout.write(`${JSON.stringify(stripWireJsonRpc(request))}\n`);
    return;
  }

  const result = await requestCodexAppServerApproval(request, options);
  writeJsonLine(child.stdin, responseForDecision(request, result.appServerDecision));
}

function responseForDecision(request: CodexJsonRpcRequest, decision: string): Record<string, unknown> {
  return {
    id: request.id ?? null,
    result: decision,
  };
}

function stripWireJsonRpc(request: CodexJsonRpcRequest): Record<string, unknown> {
  const { jsonrpc: _jsonrpc, ...wire } = request;
  return wire;
}

function writeJsonLine(stream: Writable, value: unknown): void {
  stream.write(`${JSON.stringify(value)}\n`);
}

function parseJsonLine(line: string): unknown | undefined {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}

function parseCodexAppServerArgs(args: string[]): CodexAppServerCommandOptions {
  const options: CodexAppServerCommandOptions = {
    commandArgs: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--fixture') {
      options.fixturePath = next;
      i++;
    } else if (arg === '--adapter') {
      if (next === 'mock' || next === 'file' || next === 'http') options.adapter = next;
      i++;
    } else if (arg === '--mock-decision') {
      const decision = parseMockDecision(next);
      if (decision) options.mockDecision = decision;
      i++;
    } else if (arg === '--timeout') {
      const parsed = Number(next || '300');
      if (Number.isFinite(parsed) && parsed > 0) options.timeoutSeconds = parsed;
      i++;
    } else if (arg === '--server-url') {
      options.serverUrl = next;
      i++;
    } else if (arg === '--accept-scope') {
      const scope = parseAcceptScope(next);
      if (scope) options.acceptScope = scope;
      i++;
    } else if (arg === '--command') {
      options.command = next;
      i++;
    } else if (arg === '--command-arg') {
      if (next) options.commandArgs.push(next);
      i++;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    }
  }

  return options;
}

function parseMockDecision(value: string | undefined): CodexApprovalStatus | undefined {
  if (value === 'approved' || value === 'rejected' || value === 'timeout' || value === 'pending') return value;
  return undefined;
}

function parseAcceptScope(value: string | undefined): CodexAppServerAcceptScope | undefined {
  if (value === 'once' || value === 'session') return value;
  return undefined;
}
