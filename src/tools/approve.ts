import { z } from 'zod';
import { type Config, loadConfig, shouldAutoApprove } from '../config.js';
import { getAuthHeaders } from '../utils/auth.js';
import { pollForDecision } from '../utils/poll.js';
import { SESSION_ID } from '../index.js';
import { MCP_PACKAGE_VERSION } from '../version.js';

/**
 * Request Approval Tool
 *
 * Submits an approval request to the Orbiter Dev mobile app (iOS and Android).
 * Used by AI agents to request explicit human sign-off before running
 * potentially risky or irreversible operations.
 *
 * ARCHITECTURE BOUNDARY:
 * This MCP tool is the model-facing approval channel.
 * It creates approvals via REST POST /api/v1/approvals when an AI agent
 * calls `request_approval` over MCP.
 *
 * SECURITY INVARIANT (F01):
 * The server's recorded terminal decision for the tracked approval ID is
 * strictly authoritative. Local auto-approval hints never bypass server
 * confirmation: `pending` remains pending until a server terminal verdict or
 * timeout, `rejected`/`denied`/`expired` returns `approved: false`, absent or
 * incomplete responses fail closed (`approved: false`), and `approved: true`
 * is returned ONLY when the server confirms terminal `approved` for that ID.
 */

// Input schema for the tool
const RequestApprovalInputSchema = z.object({
    action: z.string().min(1).describe('Short verb or category naming the operation requiring sign-off (e.g., "deploy", "delete", "db_migrate", "send_email").'),
    description: z.string().min(1).describe('Clear human-readable summary of what will happen, including target resources, scope, and impact, displayed on the mobile approval card.'),
    risk_analysis: z.string().min(1).describe('Concise reasoning explaining why this action is necessary, potential blast radius, and safeguards or rollback steps.'),
    files: z.array(z.string()).optional().describe('Optional list of repository or filesystem paths affected by this action.'),
    diffSummary: z.string().optional().describe('Optional concise summary or snippet of code changes or command arguments for review.'),
    riskLevel: z.enum(['low', 'medium', 'high', 'critical']).optional().default('low')
        .describe('Risk severity tier shown on the mobile card: low, medium, high (biometric confirmation), or critical (irreversible/production impact). Defaults to "low".'),
    workspaceName: z.string().optional().describe('Optional display name for the current project or workspace shown on the mobile card. Defaults to the current working directory name.'),
});

type RequestApprovalInput = z.infer<typeof RequestApprovalInputSchema>;

export interface RequestApprovalOptions {
    serverUrl?: string;
    timeoutSeconds?: number;
    pollIntervalMs?: number;
    cwd?: string;
    homeDir?: string;
    userConfigPath?: string;
    config?: Config;
}

const TERMINAL_UNAPPROVED_STATUSES = new Set(['rejected', 'denied', 'expired', 'cancelled']);

function extractNullableString(value: unknown): string | undefined {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : undefined;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return String(value);
    }
    if (value && typeof value === 'object' && 'String' in value) {
        const nullable = value as { String?: unknown; Valid?: unknown };
        if (nullable.Valid === false) return undefined;
        if (typeof nullable.String === 'string') {
            const trimmed = nullable.String.trim();
            return trimmed.length > 0 ? trimmed : undefined;
        }
    }
    return undefined;
}

function parsePositiveNumber(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Tool definition for MCP
export const requestApprovalTool = {
    name: 'request_approval',
    description: `Request explicit human sign-off on the Orbiter Dev mobile app (iOS and Android, with Face ID and Android biometrics for high-risk actions) before running irreversible, external, or high-impact actions.

When to use:
- Deploying to production or modifying infrastructure
- Deleting files, databases, or cloud resources
- Changing security policies, permissions, or sensitive configuration
- Sending external communications or executing financial/operational side effects

Routing rule: Use \`request_approval\` whenever execution must block for human sign-off. For one-way informational alerts that do not require permission, use \`notify_user\` instead.

Blocking & return payload: Pauses via SSE (with polling fallback, default timeout 300s via \`ORBITER_APPROVAL_TIMEOUT_SECONDS\`) and returns JSON with \`success\` (boolean), \`approved\` (boolean), \`status\` (\`"approved"\`, \`"rejected"\`, \`"denied"\`, \`"cancelled"\`, \`"expired"\`, \`"timeout"\`, or \`"incomplete"\`), \`message\`, \`approval_id\`, and optional \`response_notes\`.

Fail-closed outcomes:
- \`approved\`: \`{ success: true, approved: true, status: "approved", approval_id, response_notes }\` - safe to proceed.
- \`rejected\` / \`denied\` / \`cancelled\`: \`{ success: true, approved: false, status: "rejected"|"denied"|"cancelled", approval_id, response_notes }\` - halt and do not execute.
- \`expired\` / \`timeout\` / \`incomplete\` / error: \`approved: false\` (with \`error\` and \`hint\` on transport failures, or authentication instructions on HTTP 401 prompting \`orbiter_auth\`). Never treat pending, timeout, expired, incomplete, or error responses as approved.`,
    annotations: {
        title: 'Request Mobile Approval',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
    },
    inputSchema: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                minLength: 1,
                description: 'Short verb or category naming the operation requiring sign-off (required, non-empty string; e.g., "deploy", "delete", "db_migrate", "send_email").',
            },
            description: {
                type: 'string',
                minLength: 1,
                description: 'Clear human-readable summary of what will happen, including target resources, scope, and impact, displayed on the mobile approval card (required, non-empty string).',
            },
            risk_analysis: {
                type: 'string',
                minLength: 1,
                description: 'Concise reasoning explaining why this action is necessary, its blast radius, and what safeguards or rollback steps exist (required, non-empty string).',
            },
            files: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional list of repository or filesystem paths affected by this action, shown to the mobile reviewer.',
            },
            diffSummary: {
                type: 'string',
                description: 'Optional concise summary or snippet of code changes or exact command arguments for the reviewer to inspect.',
            },
            riskLevel: {
                type: 'string',
                enum: ['low', 'medium', 'high', 'critical'],
                description: 'Risk severity tier shown on the mobile card: "low" (routine reversible action), "medium" (moderate impact), "high" (elevated risk with biometric confirmation), or "critical" (irreversible or production-impacting action). Optional; defaults to "low".',
                default: 'low',
            },
            workspaceName: {
                type: 'string',
                description: 'Optional display name for the current project or workspace shown on the mobile card. Defaults to the current working directory name.',
            },
        },
        required: ['action', 'description', 'risk_analysis'],
    },
};

/**
 * Handle the request_approval tool call
 */
export async function handleRequestApproval(
    args: unknown,
    options: RequestApprovalOptions = {}
): Promise<{ content: Array<{ type: string; text: string }> }> {
    // Validate input
    const input: RequestApprovalInput = RequestApprovalInputSchema.parse(args);

    const serverUrl = (
        options.serverUrl ||
        process.env.ORBITER_API_URL ||
        process.env.ORBITER_SERVER_URL ||
        'https://api.orbiterdev.ai'
    ).replace(/\/+$/, '');

    const timeoutSeconds =
        options.timeoutSeconds ??
        parsePositiveNumber(process.env.ORBITER_APPROVAL_TIMEOUT_SECONDS) ??
        300;
    const pollIntervalMs =
        options.pollIntervalMs ??
        parsePositiveNumber(process.env.ORBITER_APPROVAL_POLL_INTERVAL_MS) ??
        3000;

    const config = options.config ?? loadConfig({
        cwd: options.cwd,
        homeDir: options.homeDir,
        userConfigPath: options.userConfigPath,
    });
    let textToCheck = input.description;
    if (input.diffSummary) textToCheck += '\n' + input.diffSummary;
    if (input.files) textToCheck += '\n' + input.files.join('\n');

    // Advisory hint only: client rules NEVER locally grant approval while the
    // server holds a pending, rejected, expired, or incomplete request.
    const autoApproveHint = shouldAutoApprove(config, textToCheck);

    try {
        const payload = {
            action: input.action,
            description: input.description,
            diff_summary: input.diffSummary || input.files?.join('\n') || 'No details provided',
            file_count: input.files ? input.files.length : 0,
            risk_level: input.riskLevel,
            source_ide: detectIDE(),
            source_extension_version: `mcp-${MCP_PACKAGE_VERSION}`,
            workspace_name: input.workspaceName || extractWorkspaceName(),
            auto_approve: autoApproveHint,
            session_id: SESSION_ID,
        };

        const response = await fetch(`${serverUrl}/api/v1/approvals`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const text = await response.text();

            if (response.status === 401) {
                const { loadCredentials, getCredentialPath } = await import('../auth/credentials.js');
                const fs = await import('fs');

                if (loadCredentials()) {
                    try {
                        if (fs.existsSync(getCredentialPath())) fs.unlinkSync(getCredentialPath());
                    } catch {
                        // Ignore cleanup failures
                    }
                    return {
                        content: [{ type: 'text', text: 'Authentication expired or invalid. Please run the `orbiter_auth` tool to re-pair with your Orbiter mobile app.' }],
                    };
                } else {
                    return {
                        content: [{ type: 'text', text: 'Not authenticated. Please ask the user to run the `orbiter_auth` tool to pair with their Orbiter mobile app.' }],
                    };
                }
            }

            throw new Error(`Server responded with ${response.status}: ${text}`);
        }

        const rawBody = await response.text();
        let parsedBody: unknown;
        try {
            parsedBody = rawBody.trim() ? JSON.parse(rawBody) : null;
        } catch {
            parsedBody = null;
        }

        const approvalRecord = isRecord(parsedBody) && isRecord(parsedBody.data)
            ? parsedBody.data
            : undefined;
        const approvalId = extractNullableString(approvalRecord?.id);

        if (!approvalId) {
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        success: false,
                        approved: false,
                        status: 'incomplete',
                        message: 'Server returned an incomplete approval response (missing approval ID). Do not proceed with the action.',
                    }, null, 2),
                }],
            };
        }

        const initialStatus = extractNullableString(approvalRecord?.status)?.toLowerCase();
        const initialNotes = extractNullableString(approvalRecord?.response_notes) ?? '';

        // Honor authoritative terminal decisions recorded immediately by the server.
        if (initialStatus === 'approved') {
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        success: true,
                        approved: true,
                        status: 'approved',
                        message: 'APPROVED - Server confirmed approval. You may proceed with the action.',
                        response_notes: initialNotes,
                        approval_id: approvalId,
                    }, null, 2),
                }],
            };
        }

        if (initialStatus && TERMINAL_UNAPPROVED_STATUSES.has(initialStatus)) {
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        success: true,
                        approved: false,
                        status: initialStatus,
                        message: initialStatus === 'expired'
                            ? 'EXPIRED - Approval request expired. Do not proceed with the action.'
                            : 'REJECTED - Do not proceed with the action.',
                        response_notes: initialNotes,
                        approval_id: approvalId,
                    }, null, 2),
                }],
            };
        }

        // Server recorded pending (or omitted status): wait for authoritative
        // terminal decision bound to this approvalId via SSE-first, polling fallback.
        let decision: { status: string; notes: string; timedOut: boolean };

        try {
            const { sseWaitForDecision } = await import('../utils/sse.js');
            decision = await sseWaitForDecision(serverUrl, approvalId, timeoutSeconds);
        } catch {
            // SSE failed - fall back to polling
            process.stderr.write('[orbiter] SSE unavailable, falling back to polling\n');
            decision = await pollForDecision(serverUrl, approvalId, timeoutSeconds, pollIntervalMs);
        }

        if (decision.timedOut) {
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        success: false,
                        approved: false,
                        status: 'timeout',
                        message: `Approval request timed out - no decision received within ${timeoutSeconds} seconds. Do not proceed with the action.`,
                        approval_id: approvalId,
                    }, null, 2),
                }],
            };
        }

        const finalStatus = (decision.status || '').trim().toLowerCase();

        if (finalStatus === 'approved') {
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        success: true,
                        approved: true,
                        status: 'approved',
                        message: 'APPROVED - You may proceed with the action.',
                        response_notes: decision.notes,
                        approval_id: approvalId,
                    }, null, 2),
                }],
            };
        }

        if (TERMINAL_UNAPPROVED_STATUSES.has(finalStatus)) {
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        success: true,
                        approved: false,
                        status: finalStatus,
                        message: finalStatus === 'expired'
                            ? 'EXPIRED - Approval request expired. Do not proceed with the action.'
                            : 'REJECTED - Do not proceed with the action.',
                        response_notes: decision.notes,
                        approval_id: approvalId,
                    }, null, 2),
                }],
            };
        }

        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    success: false,
                    approved: false,
                    status: finalStatus || 'incomplete',
                    message: 'Approval did not reach a confirmed server decision. Do not proceed with the action.',
                    response_notes: decision.notes,
                    approval_id: approvalId,
                }, null, 2),
            }],
        };

    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({
                        success: false,
                        approved: false,
                        error: errorMessage,
                        hint: 'Verify connectivity to your configured ORBITER_API_URL (default https://api.orbiterdev.ai).',
                    }, null, 2),
                },
            ],
        };
    }
}

/**
 * Auto-detect which IDE is running the MCP server.
 * Uses environment variables set by each IDE's MCP configuration.
 *
 * Detection priority:
 * 1. IDE-specific env vars (most reliable)
 * 2. MCP_CLIENT_NAME (set by some MCP hosts)
 * 3. process.env.TERM_PROGRAM (terminal-based detection)
 * 4. Parent process name heuristics
 */
export function detectIDE(): string {
    // Antigravity injects ANTIGRAVITY_IDE=true via .mcp.json env block.
    // Check this BEFORE VSCODE_PID - Antigravity is a VS Code fork and
    // inherits VSCODE_PID, so without this check it falls through to 'VS Code'.
    if (process.env.ANTIGRAVITY_IDE === 'true') return 'Antigravity';
    // Antigravity may also set these session vars
    if (process.env.ANTIGRAVITY_SESSION || process.env.WINDSURF_SESSION) return 'Antigravity';
    // Cursor sets CURSOR_* env vars
    if (process.env.CURSOR_TRACE_ID || process.env.CURSOR_SESSION_ID) return 'Cursor';
    // Claude Code is the MCP native client
    if (process.env.CLAUDE_CODE || process.env.MCP_CLIENT === 'claude') return 'Claude Code';
    // VS Code generic (after all VS Code forks checked above)
    if (process.env.VSCODE_PID) return 'VS Code';
    // Generic MCP client name (some hosts set this)
    if (process.env.MCP_CLIENT_NAME) return process.env.MCP_CLIENT_NAME;
    // Terminal-based detection for Claude Code (often runs in terminal)
    if (process.env.TERM_PROGRAM === 'vscode') return 'VS Code';
    // Zed editor detection
    if (process.env.ZED_TERM) return 'Zed';

    // Last resort: meaningful fallback (never 'unknown')
    return 'MCP Agent';
}

/**
 * Extract workspace name from the current working directory.
 * Falls back gracefully to avoid showing 'unknown' on mobile cards.
 */
export function extractWorkspaceName(): string {
    try {
        const cwd = process.cwd();
        const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
        return parts[parts.length - 1] || cwd;
    } catch {
        return 'workspace';
    }
}
