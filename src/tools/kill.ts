import { z } from 'zod';
import { getAuthHeaders } from '../utils/auth.js';

/**
 * Kill Agent Tool (SF-001)
 * 
 * Terminates an active agent session via the Orbiter backend.
 * The backend sets the session state to 'killed' and broadcasts
 * a WebSocket event to terminate the agent process on the IDE side.
 */

const KillAgentInputSchema = z.object({
    session_id: z.string().uuid()
        .describe('UUID v4 identifier of the target active agent session to terminate (from the Orbiter Dev mobile app, dashboard, or session startup logs).'),
    reason: z.string().optional()
        .describe('Optional human-readable explanation recorded in the audit log for why the session was terminated. Defaults to "Kill switch activated via MCP".'),
});

type KillAgentInput = z.infer<typeof KillAgentInputSchema>;

export const killAgentTool = {
    name: 'kill_agent',
    description: `Terminate an active AI agent session immediately by setting its state to "killed" in the Orbiter Dev backend and broadcasting a stop signal to connected clients.

Use this tool only when:
- An agent is stuck in a loop or unresponsive
- You must halt a runaway agent before further side effects occur
- The user explicitly requests session termination
- A dead-man switch has triggered (no heartbeat in 60s)

Routing rule: Destructive control action (in-progress work in that session may be lost). Do not use \`kill_agent\` to pause for confirmation before an action (use \`request_approval\`) or to send an informational alert (use \`notify_user\`).

Returns JSON with \`success: true\`, \`session_id\`, \`status: "killed"\`, \`message\`, and \`data\` (backend response containing \`session_id\`, \`status\`, \`reason\`, and \`killed_at\` timestamp).

Idempotency & error behavior:
- Calling \`kill_agent\` on an already-terminated session owned by the same user is idempotent and returns \`success: true\` with \`status: "killed"\`.
- If \`session_id\` is unknown (HTTP 404), belongs to another account (HTTP 403), authentication is missing/expired (HTTP 401), or the backend is unreachable, returns structured non-throwing JSON with \`success: false\`, \`session_id\`, \`error\`, and \`hint\`. Malformed non-UUID \`session_id\` values fail input validation before any network call.`,
    annotations: {
        title: 'Terminate Agent Session',
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
    },
    inputSchema: {
        type: 'object',
        properties: {
            session_id: {
                type: 'string',
                format: 'uuid',
                description: 'UUID v4 identifier of the target agent session to terminate (required; obtain from the Orbiter Dev mobile app, dashboard, or session startup logs).',
            },
            reason: {
                type: 'string',
                description: 'Optional human-readable explanation recorded in the audit log and kill broadcast. Defaults to "Kill switch activated via MCP".',
            },
        },
        required: ['session_id'],
    },
};

export async function handleKillAgent(
    args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
    const input: KillAgentInput = KillAgentInputSchema.parse(args);
    const serverUrl = (
        process.env.ORBITER_API_URL ||
        process.env.ORBITER_SERVER_URL ||
        'https://api.orbiterdev.ai'
    ).replace(/\/+$/, '');

    try {
        const response = await fetch(`${serverUrl}/api/v1/sessions/${encodeURIComponent(input.session_id)}/kill`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({
                reason: input.reason || 'Kill switch activated via MCP',
            }),
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Server responded with ${response.status}: ${text}`);
        }

        const data = await response.json() as Record<string, unknown>;

        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    success: true,
                    session_id: input.session_id,
                    status: 'killed',
                    message: `Agent session ${input.session_id} has been terminated`,
                    data,
                }, null, 2),
            }],
        };
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    success: false,
                    session_id: input.session_id,
                    error: errorMessage,
                    hint: 'Verify the session UUID exists, belongs to your paired account, and ORBITER_API_URL is reachable',
                }, null, 2),
            }],
        };
    }
}
