import { z } from 'zod';
import { getAuthHeaders } from '../utils/auth.js';

/**
 * Notify User Tool (MCP-012)
 * 
 * Sends a push notification to the user via ntfy.sh.
 * Falls back to the backend /notify endpoint if ntfy topic is not configured.
 */

const NotifyInputSchema = z.object({
    title: z.string().describe('Notification title'),
    message: z.string().describe('Notification body text'),
    priority: z.enum(['low', 'default', 'high', 'urgent']).optional().default('default')
        .describe('Notification priority level'),
});

type NotifyInput = z.infer<typeof NotifyInputSchema>;

export const notifyUserTool = {
    name: 'notify_user',
    description: `Send a push notification to the user's phone via Orbiter Dev or ntfy.sh.

Use this tool to alert the user about important events:
- Task completed successfully
- Error that needs attention
- Question that requires human input
- Deployment or build status updates

Configure a direct ntfy topic via ORBITER_NTFY_TOPIC, or leave unset to route via your configured ORBITER_API_URL.`,
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
                description: 'Notification title',
            },
            message: {
                type: 'string',
                description: 'Notification body text',
            },
            priority: {
                type: 'string',
                enum: ['low', 'default', 'high', 'urgent'],
                description: 'Notification priority',
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

    // Check for direct ntfy topic (preferred)
    const ntfyTopic = process.env.ORBITER_NTFY_TOPIC;

    if (ntfyTopic) {
        return sendViaNtfy(ntfyTopic, input);
    }

    // Fallback: send via backend
    return sendViaBackend(input);
}

async function sendViaNtfy(
    topic: string,
    input: NotifyInput
): Promise<{ content: Array<{ type: string; text: string }> }> {
    try {
        const response = await fetch(`https://ntfy.sh/${topic}`, {
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
                    message: `Notification sent via ntfy.sh topic "${topic}"`,
                    provider: 'ntfy.sh',
                }, null, 2),
            }],
        };
    } catch (error: any) {
        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    success: false,
                    error: error.message,
                    hint: `Check ntfy.sh topic "${topic}" is valid`,
                }, null, 2),
            }],
        };
    }
}

async function sendViaBackend(
    input: NotifyInput
): Promise<{ content: Array<{ type: string; text: string }> }> {
    const serverUrl = process.env.ORBITER_SERVER_URL || 'https://api.orbiterdev.ai';

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
                    message: 'Notification sent via backend',
                    provider: 'backend',
                }, null, 2),
            }],
        };
    } catch (error: any) {
        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    success: false,
                    error: error.message,
                    hint: 'Set ORBITER_NTFY_TOPIC env var for direct ntfy.sh delivery',
                }, null, 2),
            }],
        };
    }
}
