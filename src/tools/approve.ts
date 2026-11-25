import { z } from 'zod';
import { loadConfig, shouldAutoApprove } from '../config.js';
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
 * Native lifecycle hooks (`PreToolUse`, `BeforeTool`, `PermissionRequest`)
 * are the deterministic, fail-closed IDE enforcement channel.
 */

// Input schema for the tool
const RequestApprovalInputSchema = z.object({
    action: z.string().describe('The action requiring approval (e.g., "deploy", "delete", "modify")'),
    description: z.string().describe('Human-readable description of what will happen'),
    risk_analysis: z.string().describe('Step-by-step reasoning explaining why this action is safe and necessary before execution.'),
    files: z.array(z.string()).optional().describe('List of files that will be affected'),
    diffSummary: z.string().optional().describe('Summary of code changes'),
    riskLevel: z.enum(['low', 'medium', 'high', 'critical']).optional().default('low')
        .describe('Risk level of the operation'),
    workspaceName: z.string().optional().describe('Name of the current workspace'),
});

type RequestApprovalInput = z.infer<typeof RequestApprovalInputSchema>;

// Tool definition for MCP
export const requestApprovalTool = {
    name: 'request_approval',
    description: `Request explicit human sign-off via the Orbiter Dev mobile app (iOS and Android) before running irreversible, external, or high-impact actions.

Use this tool when:
- Deploying to production
- Deleting files, databases, or cloud resources
- Modifying sensitive configuration or security policies
- Taking external actions that require explicit confirmation

Pass the action name, summary, risk analysis, and risk level. The user receives a push notification on their phone (with Face ID or Android biometrics for high-risk actions) and execution pauses until a decision is returned.`,
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
                description: 'The action requiring approval',
            },
            description: {
                type: 'string',
                description: 'Human-readable description of what will happen',
            },
            risk_analysis: {
                type: 'string',
                description: 'Step-by-step reasoning explaining why this action is safe and necessary before execution.',
            },
            files: {
                type: 'array',
                items: { type: 'string' },
                description: 'List of files that will be affected',
            },
            diffSummary: {
                type: 'string',
                description: 'Summary of code changes',
            },
            riskLevel: {
                type: 'string',
                enum: ['low', 'medium', 'high', 'critical'],
                description: 'Risk level of the operation',
                default: 'low',
            },
            workspaceName: {
                type: 'string',
                description: 'Name of the current workspace',
            },
        },
        required: ['action', 'description', 'risk_analysis'],
    },
};

/**
 * Handle the request_approval tool call
 */
export async function handleRequestApproval(
    args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
    // Validate input
    const input: RequestApprovalInput = RequestApprovalInputSchema.parse(args);

    const serverUrl = process.env.ORBITER_API_URL || process.env.ORBITER_SERVER_URL || 'https://api.orbiterdev.ai';

    const config = loadConfig();
    let textToCheck = input.description;
    if (input.diffSummary) textToCheck += '\n' + input.diffSummary;
    if (input.files) textToCheck += '\n' + input.files.join('\n');

    const isAutoApproved = shouldAutoApprove(config, textToCheck);

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
            auto_approve: isAutoApproved,
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

        const data: any = await response.json();
        const approvalId = data.data?.id;

        if (!approvalId) {
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        success: true,
                        message: 'Approval request submitted (no ID returned - cannot track status)',
                        data: data.data,
                    }, null, 2),
                }],
            };
        }

        // If auto-approved, skip polling
        if (isAutoApproved) {
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        success: true,
                        approved: true,
                        message: 'Auto-approved by policy rule',
                        approval_id: approvalId,
                    }, null, 2),
                }],
            };
        }

        // SSE-first, polling fallback:
        // SSE opens a single persistent connection (10x more efficient than polling).
        // Falls back to HTTP polling if SSE fails (corporate proxies, etc).
        let decision: { status: string; notes: string; timedOut: boolean };

        try {
            const { sseWaitForDecision } = await import('../utils/sse.js');
            decision = await sseWaitForDecision(serverUrl, approvalId.toString());
        } catch {
            // SSE failed - fall back to polling
            process.stderr.write('[orbiter] SSE unavailable, falling back to polling\n');
            decision = await pollForDecision(serverUrl, approvalId.toString());
        }

        if (decision.timedOut) {
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        success: false,
                        approved: false,
                        message: 'Approval request timed out - no decision received within 300 seconds. Do not proceed with the action.',
                        approval_id: approvalId,
                    }, null, 2),
                }],
            };
        }

        const wasApproved = decision.status === 'approved';

        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    success: true,
                    approved: wasApproved,
                    status: decision.status,
                    message: wasApproved
                        ? 'APPROVED - You may proceed with the action.'
                        : 'REJECTED - Do not proceed with the action.',
                    response_notes: decision.notes,
                    approval_id: approvalId,
                }, null, 2),
            }],
        };

    } catch (error: any) {
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({
                        success: false,
                        error: error.message,
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
