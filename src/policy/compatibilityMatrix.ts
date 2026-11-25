/**
 * Hooks compatibility matrix (hosted-hooks paper, §2.6.4 / §5.4): the server-owned mapping
 * of IDE x version -> correct hook shape, supported events, trust mechanism, and fail-policy.
 * This is where version skew is absorbed *centrally*, not in brittle client `if (version...)`.
 *
 * v1 is a static default; later it is pulled (ETag-gated) from the control plane and the
 * reconciler applies it. Additive and self-contained - not yet wired into setup/doctor.
 */

export type Ide = 'claude' | 'codex' | 'antigravity' | 'gemini';
export type TrustMode = 'managed' | 'hash-trust' | 'workspace-file' | 'settings-file';
export type FailPolicy = 'fail-open' | 'fail-closed';
export type EdgeMode = 'http-hook' | 'command-shim';

export interface HookCapability {
  ide: Ide;
  /** Inclusive minimum version this entry applies to (numeric-dotted compare). */
  minVersion: string;
  /** Where/how the hook config lives. */
  configKind: string;
  /** Hook events this surface can gate/observe. */
  events: string[];
  /** Trust mechanism (drives whether updates re-prompt). */
  trust: TrustMode;
  /** Edge entrypoint kind. */
  edge: EdgeMode;
  /** Recommended fail-policy for high-risk gating on this surface. */
  failPolicy: FailPolicy;
  note?: string;
}

export interface CompatibilityMatrix {
  version: string;
  /** Conservative fallback for unknown IDE/version (lean fail-closed for safety). */
  fallback: Omit<HookCapability, 'ide' | 'minVersion'>;
  entries: HookCapability[];
}

export const DEFAULT_COMPATIBILITY_MATRIX: CompatibilityMatrix = {
  version: '2026-06-21.1',
  fallback: {
    configKind: 'command-shim',
    events: ['PreToolUse'],
    trust: 'settings-file',
    edge: 'command-shim',
    failPolicy: 'fail-closed',
    note: 'unknown IDE/version - conservative shim; fail closed for high risk',
  },
  entries: [
    {
      ide: 'claude',
      minVersion: '0.0.0',
      configKind: 'settings.json (+ managed settings for orgs)',
      events: ['PreToolUse', 'PermissionRequest', 'PostToolUse'],
      trust: 'settings-file',
      edge: 'http-hook',
      failPolicy: 'fail-closed',
      note: 'HTTP hook fails open -> telemetry/fallback only; high-risk gate via shim',
    },
    {
      ide: 'codex',
      minVersion: '0.0.0',
      configKind: 'requirements.toml+managed_dir (enterprise) | ~/.codex/hooks.json (solo)',
      events: ['PreToolUse', 'PermissionRequest', 'PostToolUse'],
      trust: 'hash-trust',
      edge: 'command-shim',
      failPolicy: 'fail-closed',
      note: 'managed hooks skip hash trust (enterprise); solo accepts rare re-trust',
    },
    {
      ide: 'antigravity',
      minVersion: '0.0.0',
      configKind: '.agents/hooks.json (per workspace)',
      events: ['PreToolUse', 'PostToolUse', 'PreInvocation', 'PostInvocation', 'Stop'],
      trust: 'workspace-file',
      edge: 'command-shim',
      failPolicy: 'fail-closed',
      note: 'per-workspace; quote-free runner; native command policy must allow continuation',
    },
    {
      ide: 'gemini',
      minVersion: '0.0.0',
      configKind: '.gemini/settings.json',
      events: ['BeforeTool', 'AfterTool'],
      trust: 'settings-file',
      edge: 'command-shim',
      failPolicy: 'fail-closed',
    },
  ],
};

function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Resolve the hook capability for an IDE+version, or the conservative fallback. */
export function resolveMatrix(
  ide: string,
  version: string,
  matrix: CompatibilityMatrix = DEFAULT_COMPATIBILITY_MATRIX,
): HookCapability {
  const candidates = matrix.entries
    .filter((e) => e.ide === ide && cmpVersion(version, e.minVersion) >= 0)
    .sort((a, b) => cmpVersion(b.minVersion, a.minVersion));
  if (candidates[0]) return candidates[0];
  return { ide: ide as Ide, minVersion: version, ...matrix.fallback };
}
