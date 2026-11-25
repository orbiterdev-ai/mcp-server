import { readFile } from 'fs/promises';
import { resolve } from 'path';
import type {
  AntigravityApprovalFallback,
  AntigravityApprovalStatus,
  AntigravityHookHandleOptions,
  AntigravityHookProfile,
} from '../antigravity/types.js';
import { handleAntigravityHook, parseAntigravityHookEventName } from '../antigravity/hooks.js';
import {
  applyOfflineCaptureDefaults,
  captureFailClosedOutput,
  rawPayloadForParseError,
  scanHookCaptureSecrets,
  writeHookCaptureReceipt,
} from '../hookCapture.js';

interface AntigravityHookCommandOptions extends AntigravityHookHandleOptions {
  fixturePath?: string;
  captureDir?: string;
}

export async function handleAntigravityHookCommand(args: string[]): Promise<void> {
  const options = parseAntigravityHookArgs(args);
  applyOfflineCaptureDefaults(options);
  if (options.serverUrl) process.env.ORBITER_SERVER_URL = options.serverUrl;
  if (options.timeoutSeconds) process.env.ORBITER_CODEX_TIMEOUT_SECONDS = String(options.timeoutSeconds);

  const raw = options.fixturePath
    ? await readFile(resolve(options.fixturePath), 'utf8')
    : await readStdin();
  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch (error) {
    if (!options.captureDir) throw error;
    const parsePayload = rawPayloadForParseError(raw, error);
    const eventName = options.eventName || 'PreToolUse';
    const output = captureFailClosedOutput('antigravity', eventName, 'Invalid Antigravity hook JSON; Orbiter offline capture failed closed.');
    const stdout = `${JSON.stringify(output)}\n`;
    await writeHookCaptureReceipt({
      captureDir: options.captureDir,
      provider: 'antigravity',
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

  const eventName = options.eventName || 'PreToolUse';
  if (options.captureDir && !scanHookCaptureSecrets(payload)) {
    const output = captureFailClosedOutput('antigravity', eventName, 'Orbiter offline capture blocked credential-shaped hook payload.');
    const stdout = `${JSON.stringify(output)}\n`;
    await writeHookCaptureReceipt({
      captureDir: options.captureDir,
      provider: 'antigravity',
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

  const result = await handleAntigravityHook(payload, options);
  const stdout = `${JSON.stringify(result.output)}\n`;
  if (options.captureDir) {
    await writeHookCaptureReceipt({
      captureDir: options.captureDir,
      provider: 'antigravity',
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

function parseAntigravityHookArgs(args: string[]): AntigravityHookCommandOptions {
  const options: AntigravityHookCommandOptions = {
    eventName: 'PreToolUse',
    profile: 'blocking',
    fallback: 'deny',
  };
  let index = 0;
  if (args[0] && !args[0].startsWith('--')) {
    options.eventName = parseAntigravityHookEventName(args[0]);
    index = 1;
  }

  for (let i = index; i < args.length; i++) {
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
    } else if (arg === '--profile') {
      const profile = parseProfile(next);
      if (profile) options.profile = profile;
      i++;
    } else if (arg === '--fallback') {
      const fallback = parseFallback(next);
      if (fallback) options.fallback = fallback;
      i++;
    } else if (arg === '--critical') {
      if (next === 'ask' || next === 'deny') options.criticalMode = next;
      i++;
    }
  }
  return options;
}

function parseMockDecision(value: string | undefined): AntigravityApprovalStatus | undefined {
  if (value === 'approved' || value === 'rejected' || value === 'timeout' || value === 'pending') return value;
  return undefined;
}

function parseProfile(value: string | undefined): AntigravityHookProfile | undefined {
  if (value === 'observe' || value === 'blocking' || value === 'strict') return value;
  return undefined;
}

function parseFallback(value: string | undefined): AntigravityApprovalFallback | undefined {
  if (value === 'deny' || value === 'force_ask') return value;
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
