import fs from 'fs';
import path from 'path';
import type { GeminiApprovalAdapterName, GeminiApprovalStatus, GeminiHookEventName } from '../gemini/types.js';
import { GEMINI_HOOK_EVENTS } from '../gemini/types.js';
import { handleGeminiHook } from '../gemini/hooks.js';
import {
  applyOfflineCaptureDefaults,
  captureEventFromPayload,
  captureFailClosedOutput,
  rawPayloadForParseError,
  scanHookCaptureSecrets,
  writeHookCaptureReceipt,
} from '../hookCapture.js';

interface GeminiHookCommandOptions {
  eventName?: GeminiHookEventName;
  fixture?: string;
  adapter?: GeminiApprovalAdapterName;
  mockDecision?: GeminiApprovalStatus;
  serverUrl?: string;
  timeoutSeconds?: number;
  captureDir?: string;
  criticalMode?: 'ask' | 'deny';
  fallback?: 'deny' | 'allow';
}

export async function handleGeminiHookCommand(args: string[]): Promise<void> {
  const options = parseGeminiHookArgs(args);
  applyOfflineCaptureDefaults(options);
  const raw = options.fixture
    ? fs.readFileSync(path.resolve(options.fixture), 'utf8')
    : await readStdin();
  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch (error) {
    if (!options.captureDir) throw error;
    const parsePayload = rawPayloadForParseError(raw, error);
    const eventName = options.eventName || 'unknown';
    const output = captureFailClosedOutput('gemini', eventName, 'Invalid Gemini CLI hook JSON; Orbiter offline capture failed closed.');
    const stdout = `${JSON.stringify(output)}\n`;
    await writeHookCaptureReceipt({
      captureDir: options.captureDir,
      provider: 'gemini',
      event: eventName,
      rawPayload: parsePayload,
      hookOutput: output,
      stdoutReturnedToIde: stdout,
      adapter: options.adapter,
      decisionScenario: options.mockDecision,
      secretScanPassed: scanHookCaptureSecrets(parsePayload),
    });
    process.stdout.write(stdout);
    return;
  }

  const eventName = options.eventName || captureEventFromPayload(payload);
  if (options.captureDir && !scanHookCaptureSecrets(payload)) {
    const output = captureFailClosedOutput('gemini', eventName, 'Orbiter offline capture blocked credential-shaped hook payload.');
    const stdout = `${JSON.stringify(output)}\n`;
    await writeHookCaptureReceipt({
      captureDir: options.captureDir,
      provider: 'gemini',
      event: eventName,
      rawPayload: payload,
      hookOutput: output,
      stdoutReturnedToIde: stdout,
      adapter: options.adapter,
      decisionScenario: options.mockDecision,
      secretScanPassed: false,
    });
    process.stdout.write(stdout);
    return;
  }

  const result = await handleGeminiHook(payload, {
    eventName: options.eventName,
    adapter: options.adapter,
    mockDecision: options.mockDecision,
    serverUrl: options.serverUrl,
    timeoutSeconds: options.timeoutSeconds,
    criticalMode: options.criticalMode,
    fallback: options.fallback,
  });
  const stdout = `${JSON.stringify(result.output)}\n`;
  if (options.captureDir) {
    await writeHookCaptureReceipt({
      captureDir: options.captureDir,
      provider: 'gemini',
      event: eventName,
      rawPayload: payload,
      normalizedApprovalRequest: result.normalized?.approval,
      hookOutput: result.output,
      stdoutReturnedToIde: stdout,
      adapter: options.adapter,
      decisionScenario: options.mockDecision,
      secretScanPassed: true,
    });
  }
  process.stdout.write(stdout);
}

function parseGeminiHookArgs(args: string[]): GeminiHookCommandOptions {
  const options: GeminiHookCommandOptions = {};
  let index = 0;
  if (args[0] && !args[0].startsWith('--')) {
    const eventName = parseEventName(args[0]);
    if (eventName) options.eventName = eventName;
    index = 1;
  }

  for (let i = index; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '--fixture') {
      options.fixture = next;
      i++;
    } else if (arg === '--capture-dir') {
      options.captureDir = next;
      i++;
    } else if (arg === '--adapter') {
      const adapter = parseAdapter(next);
      if (adapter) options.adapter = adapter;
      i++;
    } else if (arg === '--mock-decision') {
      const decision = parseMockDecision(next);
      if (decision) options.mockDecision = decision;
      i++;
    } else if (arg === '--server-url') {
      options.serverUrl = next;
      i++;
    } else if (arg === '--approval-timeout' || arg === '--timeout') {
      const timeout = Number(next || '300');
      if (Number.isFinite(timeout) && timeout > 0) options.timeoutSeconds = timeout;
      i++;
    } else if (arg === '--critical') {
      if (next === 'ask' || next === 'deny') options.criticalMode = next;
      i++;
    } else if (arg === '--fallback') {
      if (next === 'deny' || next === 'allow') options.fallback = next;
      i++;
    }
  }

  return options;
}

function parseEventName(value: string | undefined): GeminiHookEventName | undefined {
  if (value && GEMINI_HOOK_EVENTS.includes(value as GeminiHookEventName)) return value as GeminiHookEventName;
  return undefined;
}

function parseAdapter(value: string | undefined): GeminiApprovalAdapterName | undefined {
  if (value === 'mock' || value === 'file' || value === 'http') return value;
  return undefined;
}

function parseMockDecision(value: string | undefined): GeminiApprovalStatus | undefined {
  if (value === 'approved' || value === 'rejected' || value === 'timeout' || value === 'pending') return value;
  return undefined;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const timeout = setTimeout(() => resolve('{}'), 1000);
    process.stdin.on('data', (chunk: Buffer) => {
      clearTimeout(timeout);
      chunks.push(chunk);
    });
    process.stdin.on('end', () => {
      clearTimeout(timeout);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    process.stdin.on('error', () => {
      clearTimeout(timeout);
      resolve('{}');
    });
    process.stdin.resume();
  });
}
