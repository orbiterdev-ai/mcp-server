import fs from 'fs';
import os from 'os';
import path from 'path';
import type { CodexApprovalDecision } from './types.js';

type CacheShape = Record<string, CodexApprovalDecision & { cached_at: string }>;

function cachePath(): string {
  return process.env.ORBITER_CODEX_IDEMPOTENCY_STORE ||
    path.join(os.homedir(), '.orbiter', 'codex-idempotency.json');
}

/**
 * Only a real user verdict is idempotent. Caching 'timeout'/'pending' (e.g. one transient
 * network failure) permanently poisoned the key: every replay of the same tool call
 * returned the cached failure and denied without ever asking the phone again. Filtering
 * on read also heals caches poisoned before this fix.
 */
function isCacheableDecision(status: CodexApprovalDecision['status']): boolean {
  return status === 'approved' || status === 'rejected';
}

export function readCachedCodexDecision(key: string): CodexApprovalDecision | undefined {
  try {
    const file = cachePath();
    if (!fs.existsSync(file)) return undefined;
    const cache = JSON.parse(fs.readFileSync(file, 'utf8')) as CacheShape;
    const value = cache[key];
    if (!value) return undefined;
    const { cached_at: _cachedAt, ...decision } = value;
    if (!isCacheableDecision(decision.status)) return undefined;
    return decision;
  } catch {
    return undefined;
  }
}

export function writeCachedCodexDecision(key: string, decision: CodexApprovalDecision): void {
  if (!isCacheableDecision(decision.status)) return;
  try {
    const file = cachePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const cache: CacheShape = fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, 'utf8')) as CacheShape
      : {};
    cache[key] = { ...decision, cached_at: new Date().toISOString() };
    fs.writeFileSync(file, JSON.stringify(cache, null, 2), { mode: 0o600 });
  } catch {
    // Idempotency is a UX optimization; approval correctness must not depend on it.
  }
}
