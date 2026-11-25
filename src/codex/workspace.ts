import path from 'path';
import type { CodexSourceRuntime } from './types.js';

export function codexWorkspaceName(cwd?: string): string {
  const resolved = cwd || process.cwd();
  const base = path.basename(resolved.replace(/[/\\]$/, ''));
  return base || resolved || 'workspace';
}

export function codexSourceRuntimeFromEnv(): CodexSourceRuntime {
  const value = process.env.ORBITER_CODEX_RUNTIME;
  if (value === 'codex_app' || value === 'codex_cli' || value === 'codex_ide' || value === 'codex_sdk' || value === 'codex_app_server') {
    return value;
  }
  if (process.env.CODEX_APP_SERVER_COMMAND) return 'codex_app_server';
  if (process.env.VSCODE_PID) return 'codex_ide';
  return 'codex_app';
}
