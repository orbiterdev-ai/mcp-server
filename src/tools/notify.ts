import { z } from 'zod';
import { getAuthHeaders } from '../utils/auth.js';

/**
 * Notify User Tool (MCP-012)
 * 
 * Sends a push notification to the user via ntfy.sh.
 * Falls back to the backend /notify endpoint if ntfy topic is not configured.
 */

const NotifyInputSchema = z.object({
    title: z.string().min(1).describe('Short heading displayed on the mobile push notification banner (non-empty string, recommended under 80 characters)'),
    message: z.string().min(1).describe('Plain-text notification body describing the status update, completion summary, or alert (non-empty string, recommended under 500 characters)'),
    priority: z.enum(['low', 'default', 'high', 'urgent']).optional().default('default')
        .describe('Urgency tier controlling mobile delivery prominence: low (silent), default (standard), high (elevated), or urgent (critical). Defaults to "default".'),
});

type NotifyInput = z.infer<typeof NotifyInputSchema>;

export const notifyUserTool = {
    name: 'notify_user',
    description: `Send a one-way, fire-and-forget informational push alert to the user's phone (iOS and Android) via the Orbiter Dev backend or a direct ntfy.sh topic.

Important routing rule: This tool does not wait for a human response, does not block execution, and never substitutes for \`request_approval\`. Always use \`request_approval\` whenever human sign-off or biometric confirmation is required before proceeding.

Use this tool only for non-blocking updates:
- Task, build, or deployment completion notices
- Non-blocking errors or status milestones
- Letting the user know an artifact or question is ready for review

Delivery routing:
- If \`ORBITER_NTFY_TOPIC\` is set, sends directly to \`https://ntfy.sh/<topic>\`.
- Otherwise routes through \`ORBITER_API_URL\` (or legacy \`ORBITER_SERVER_URL\`, default \`https://api.orbiterdev.ai\`) using saved credentials or \`ORBITER_TOKEN\`.

Returns JSON with \`success\` (boolean delivery status), \`channel\` (\`"ntfy"\` or \`"orbiter_push"\`), \`provider\` (\`"ntfy.sh"\` or \`"backend"\`), \`timestamp\` (ISO-8601 UTC string), and \`message\`.

Failure behavior: Delivery errors do not throw exceptions; instead returns structured JSON with \`success: false\`, \`channel\`, \`provider\`, \`timestamp\`, \`error\`, and \`hint\` so the caller can surface a warning without crashing.`,
    annotations: {
        title: 'Notify User on Mobile',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
    },
    inputSchema: {
        type: 'object',
        properties: {
            title: {
                type: 'string',
                minLength: 1,
                description: 'Short heading displayed on the mobile push notification banner (required, non-empty string; recommended under 80 characters for lock-screen readability).',
            },
            message: {
                type: 'string',
                minLength: 1,
                description: 'Plain-text notification body describing the status update, completion summary, or alert (required, non-empty string; recommended under 500 characters).',
            },
            priority: {
                type: 'string',
                enum: ['low', 'default', 'high', 'urgent'],
                description: 'Urgency tier controlling mobile delivery prominence: "low" (silent/passive), "default" (standard alert), "high" (elevated alert), or "urgent" (critical alert). Optional; defaults to "default".',
                default: 'default',
            },
        },
        required: ['title', 'message'],
    },
};

export async function handleNotifyUser(
    args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
    const input = NotifyInputSchema.parse(args);

    // Check for direct ntfy topic (preferred when explicitly configured)
    const ntfyTopic = process.env.ORBITER_NTFY_TOPIC?.trim();

    if (ntfyTopic) {
        return sendViaNtfy(ntfyTopic, input);
    }

    // Fallback: send via Orbiter backend
    return sendViaBackend(input);
}

async function sendViaNtfy(
    topic: string,
    input: NotifyInput
): Promise<{ content: Array<{ type: string; text: string }> }> {
    const timestamp = new Date().toISOString();
    try {
        const response = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
            method: 'POST',
            headers: {
                'Title': input.title,
                'Priority': input.priority || 'default',
            },
            body: input.message,
        });

        if (!response.ok) {
            throw new Error(`ntfy.sh responded with ${response.status}`);
        }

        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    success: true,
                    channel: 'ntfy',
                    provider: 'ntfy.sh',
                    timestamp,
                    message: `Notification sent via ntfy.sh topic "${topic}"`,
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
                    channel: 'ntfy',
                    provider: 'ntfy.sh',
                    timestamp,
                    error: errorMessage,
                    hint: `Check that ORBITER_NTFY_TOPIC ("${topic}") is valid and reachable`,
                }, null, 2),
            }],
        };
    }
}

async function sendViaBackend(
    input: NotifyInput
): Promise<{ content: Array<{ type: string; text: string }> }> {
    const serverUrl = (
        process.env.ORBITER_API_URL ||
        process.env.ORBITER_SERVER_URL ||
        'https://api.orbiterdev.ai'
    ).replace(/\/+$/, '');
    const timestamp = new Date().toISOString();

    try {
        const response = await fetch(`${serverUrl}/api/v1/notify`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({
                title: input.title,
                body: input.message,
                priority: input.priority,
            }),
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Server responded with ${response.status}: ${text}`);
        }

        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    success: true,
                    channel: 'orbiter_push',
                    provider: 'backend',
                    timestamp,
                    message: 'Notification sent via Orbiter Dev mobile push backend',
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
                    channel: 'orbiter_push',
                    provider: 'backend',
                    timestamp,
                    error: errorMessage,
                    hint: 'Verify ORBITER_API_URL and pairing credentials (run orbiter_auth), or set ORBITER_NTFY_TOPIC for direct ntfy.sh delivery',
                }, null, 2),
            }],
        };
    }
}
