/**
 * Strict allowlist for genuine Orbiter internal MCP tools.
 *
 * Security boundary (F02):
 * Loop prevention MUST NEVER inspect caller-controlled tool arguments,
 * shell commands, or descriptive text. Only exact trusted tool names
 * (or structured MCP host-prefixed names where BOTH server ID and tool
 * name are allowlisted) qualify for recursive loop prevention.
 */

export const ORBITER_INTERNAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  'request_approval',
  'orbiter_auth',
  'orbiter_auth_verify',
  'check_approval_status',
  'list_pending_approvals',
  'agent_heartbeat',
  'checkpoint_post',
  'notify_user',
]);

export const ORBITER_TRUSTED_SERVER_IDS: ReadonlySet<string> = new Set([
  'orbiter',
  'orbiter-dev',
  'orbiter_dev',
  'orbiter-dev-mcp',
  'orbiter_dev_mcp',
]);

const STRUCTURED_MCP_PATTERNS: readonly RegExp[] = [
  /^mcp__([a-z0-9_-]+)__([a-z0-9_]+)$/,
  /^([a-z0-9_-]+)__([a-z0-9_]+)$/,
  /^mcp_([a-z0-9-]+)_([a-z0-9_]+)$/,
  /^([a-z0-9_-]+)[/:]([a-z0-9_]+)$/,
];

/**
 * Determine whether `toolName` identifies a genuine internal Orbiter MCP tool.
 * Deliberately accepts ONLY the tool name string and never consults arguments
 * or caller-supplied descriptions.
 */
export function isTrustedOrbiterInternalTool(toolName: unknown): boolean {
  if (typeof toolName !== 'string') {
    return false;
  }
  const normalized = toolName.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (ORBITER_INTERNAL_TOOL_NAMES.has(normalized)) {
    return true;
  }

  for (const pattern of STRUCTURED_MCP_PATTERNS) {
    const match = normalized.match(pattern);
    if (!match) continue;
    const serverId = match[1];
    const innerTool = match[2];
    if (ORBITER_TRUSTED_SERVER_IDS.has(serverId) && ORBITER_INTERNAL_TOOL_NAMES.has(innerTool)) {
      return true;
    }
  }

  return false;
}
