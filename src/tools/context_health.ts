import { z } from 'zod';
import { getAuthHeaders } from '../utils/auth.js';

/**
 * Context Health Tool (Sprint 25: F01)
 * 
 * Inspired by Claude Code's AutoCompact threshold tracking:
 *   effectiveThreshold = contextWindow - maxOutputTokens - bufferTokens
 * 
 * Agents report context usage. The backend tracks trends and fires
 * push notifications at 60%, 80%, and 95% thresholds so the user
 * can proactively compact or intervene.
 */

const ContextHealthInputSchema = z.object({
    tokens_used: z.number().int().nonnegative()
        .describe('Current tokens consumed in the context window'),
    tokens_max: z.number().int().positive()
        .describe('Maximum context window size for the current model'),
    model: z.string().optional()
        .describe('Model name (e.g., "claude-sonnet-4", "gpt-4o")'),
    session_id: z.string().optional()
        .describe('Session identifier (auto-injected if omitted)'),
});

type ContextHealthInput = z.infer<typeof ContextHealthInputSchema>;

export const contextHealthTool = {
    name: 'context_health',
    description: `Report current context window usage to Orbiter Dev mobile app.

Call this tool periodically (every 3-5 turns) to keep the user informed about context health.
The user will see a real-time gauge on their phone and receive push alerts:
- 60%: "Consider compacting soon"
- 80%: "Quality may degrade"
- 95%: "Compact NOW"

This helps prevent silent quality degradation from context window exhaustion.`,
    inputSchema: {
        type: 'object',
        properties: {
            tokens_used: {
                type: 'number',
                description: 'Current tokens used in context window',
            },
            tokens_max: {
                type: 'number',
                description: 'Maximum context window size',
            },
            model: {
                type: 'string',
                description: 'Current model name',
            },
            session_id: {
                type: 'string',
                description: 'Session identifier (auto-injected if omitted)',
            },
        },
        required: ['tokens_used', 'tokens_max'],
    },
};

export async function handleContextHealth(
    args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
    const { SESSION_ID } = await import('../index.js');
    const input = ContextHealthInputSchema.parse(args);
    const sessionId = input.session_id || SESSION_ID;
    const serverUrl = process.env.ORBITER_SERVER_URL || 'https://api.orbiterdev.ai';

    const percentage = input.tokens_max > 0
        ? Math.round((input.tokens_used / input.tokens_max) * 10000) / 100
        : 0;

    // Determine health status
    let status: 'healthy' | 'warning' | 'danger' | 'critical';
    let emoji: string;
    if (percentage >= 95) {
        status = 'critical';
        emoji = '🔴';
    } else if (percentage >= 80) {
        status = 'danger';
        emoji = '🟠';
    } else if (percentage >= 60) {
        status = 'warning';
        emoji = '⚠️';
    } else {
        status = 'healthy';
        emoji = '🟢';
    }

    try {
        const response = await fetch(`${serverUrl}/api/v1/agent/context`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({
                session_id: sessionId,
                tokens_used: input.tokens_used,
                tokens_max: input.tokens_max,
                percentage,
                model: input.model || 'unknown',
                status,
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
                    message: `${emoji} Context health reported: ${percentage}% (${status})`,
                    data: {
                        percentage,
                        status,
                        tokens_used: input.tokens_used,
                        tokens_max: input.tokens_max,
                        remaining: input.tokens_max - input.tokens_used,
                        ...data,
                    },
                }, null, 2),
            }],
        };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    success: false,
                    error: message,
                    hint: 'Ensure Orbiter Backend is running',
                }, null, 2),
            }],
        };
    }
}
