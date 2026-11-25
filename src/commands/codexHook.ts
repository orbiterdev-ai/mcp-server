import { readFile } from 'fs/promises';
import { resolve } from 'path';
import type { CodexApprovalStatus, CodexHookHandleOptions } from '../codex/types.js';
import { handleCodexHook } from '../codex/hooks.js';
import {
  applyOfflineCaptureDefaults,
  captureEventFromPayload,
  captureFailClosedOutput,
  rawPayloadForParseError,
  scanHookCaptureSecrets,
  writeHookCaptureReceipt,
} from '../hookCapture.js';

interface CodexHookCommandOptions extends CodexHookHandleOptions {
  fixturePath?: string;
  captureDir?: string;
}

export async function handleCodexHookCommand(args: string[]): Promise<void> {
  const options = parseCodexHookArgs(args);
  applyOfflineCaptureDefaults(options);
  process['env'].ORBITER_CREDENTIAL_PROFILE ||= 'codex';
  process['env'].ORBITER_IDE_NAME ||= 'Codex';
  if (options.serverUrl) process['env'].ORBITER_SERVER_URL = options.serverUrl;
  if (options.timeoutSeconds) process['env'].ORBITER_CODEX_TIMEOUT_SECONDS = String(options.timeoutSeconds);

  const raw = options.fixturePath
    ? await readFile(resolve(options.fixturePath), 'utf8')
    : await readStdin();
  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch (error) {
    if (!options.captureDir) throw error;
    const parsePayload = rawPayloadForParseError(raw, error);
    const eventName = 'unknown';
    const output = captureFailClosedOutput('codex', eventName, 'Invalid Codex hook JSON; Orbiter offline capture failed closed.');
    const stdout = `${JSON.stringify(output)}\n`;
    await writeHookCaptureReceipt({
      captureDir: options.captureDir,
      provider: 'codex',
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

  const eventName = captureEventFromPayload(payload);
  if (options.captureDir && !scanHookCaptureSecrets(payload)) {
    const output = captureFailClosedOutput('codex', eventName, 'Orbiter offline capture blocked credential-shaped hook payload.');
    const stdout = `${JSON.stringify(output)}\n`;
    await writeHookCaptureReceipt({
      captureDir: options.captureDir,
      provider: 'codex',
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

  const result = await handleCodexHook(payload, options);
  const stdout = `${JSON.stringify(result.output)}\n`;
  if (options.captureDir) {
    await writeHookCaptureReceipt({
      captureDir: options.captureDir,
      provider: 'codex',
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

function parseCodexHookArgs(args: string[]): CodexHookCommandOptions {
  const options: CodexHookCommandOptions = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '--fixture') {
      options.fixturePath = next;
      i++;
    } else if (arg === '--capture-dir') {
      options.captureDir = next;
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

function parseMockDecision(value: string | undefined): CodexApprovalStatus | undefined {
  if (value === 'approved' || value === 'rejected' || value === 'timeout' || value === 'pending') return value;
  return undefined;
}

function readStdin(): Promise<string> {
  process.stdin.setEncoding('utf8');
  return new Promise((resolveText, reject) => {
    let data = '';
    process.stdin.on('data', (chunk) => {
      data += String(chunk);
    });
    process.stdin.on('end', () => resolveText(data));
    process.stdin.on('error', reject);
  });
}
