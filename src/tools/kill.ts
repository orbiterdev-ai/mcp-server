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
        .describe('The session UUID of the agent to kill. Get this from list_connected_agents.'),
    reason: z.string().optional()
        .describe('Optional reason for killing the agent'),
});

type KillAgentInput = z.infer<typeof KillAgentInputSchema>;

export const killAgentTool = {
    name: 'kill_agent',
    description: `Terminate an active AI agent session immediately.

Use this tool when:
- An agent is stuck in a loop and not responding
- You need to stop an agent from executing a dangerous operation
- The user explicitly requests agent termination
- A dead-man switch has triggered (no heartbeat in 60s)

This sets the session state to "killed" in the Orbiter backend and broadcasts a stop signal to connected clients. Use with caution: in-progress work may be lost.`,
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
                description: 'The session UUID of the agent to kill',
            },
            reason: {
                type: 'string',
                description: 'Optional reason for killing the agent',
            },
        },
        required: ['session_id'],
    },
};

export async function handleKillAgent(
    args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
    const input = KillAgentInputSchema.parse(args);
    const serverUrl = process.env.ORBITER_SERVER_URL || 'https://api.orbiterdev.ai';

    try {
        const response = await fetch(`${serverUrl}/api/v1/sessions/${input.session_id}/kill`, {
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
                    error: errorMessage,
                    hint: 'Ensure the session ID is valid and the Orbiter backend is running',
                }, null, 2),
            }],
        };
    }
}
