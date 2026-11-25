import { z } from 'zod';
import { getAuthHeaders } from '../utils/auth.js';

/**
 * Report Usage / Cost Tracking Tool (Sprint 25: F06)
 * 
 * Inspired by Claude Code's token tracking and threshold monitoring.
 * Addresses Pain Point PP3: "$380/day cited" - developers have zero
 * visibility into what their agents cost.
 * 
 * Agents report token usage per turn. The backend calculates cost
 * using model-specific pricing and tracks cumulative spend.
 * Push notifications fire when budget thresholds are crossed.
 */

const ReportUsageInputSchema = z.object({
    tokens_input: z.number().int().nonnegative()
        .describe('Number of input/prompt tokens consumed this turn'),
    tokens_output: z.number().int().nonnegative()
        .describe('Number of output/completion tokens generated this turn'),
    model: z.string().optional()
        .describe('Model used (e.g., "claude-sonnet-4", "gpt-4o", "gemini-2.0-flash")'),
    cache_read_tokens: z.number().int().nonnegative().optional()
        .describe('Tokens served from cache (reduced cost)'),
    cache_write_tokens: z.number().int().nonnegative().optional()
        .describe('Tokens written to cache this turn'),
    session_id: z.string().optional()
        .describe('Session identifier (auto-injected if omitted)'),
});

type ReportUsageInput = z.infer<typeof ReportUsageInputSchema>;

export const reportUsageTool = {
    name: 'report_usage',
    description: `Report token usage and cost to Orbiter Dev for live cost tracking.

Call this tool after each significant interaction to track spend:
- The user sees cumulative cost on their phone (daily/weekly/monthly)
- Push alerts fire when budgets are exceeded ($5, $10, $50 configurable)
- Token efficiency metrics help identify wasteful patterns

This prevents bill shock - developers cite spending $380/day unknowingly.
The backend calculates cost using model-specific pricing tables.`,
    inputSchema: {
        type: 'object',
        properties: {
            tokens_input: {
                type: 'number',
                description: 'Input tokens consumed this turn',
            },
            tokens_output: {
                type: 'number',
                description: 'Output tokens generated this turn',
            },
            model: {
                type: 'string',
                description: 'Model name for pricing lookup',
            },
            cache_read_tokens: {
                type: 'number',
                description: 'Tokens served from prompt cache (reduced cost)',
            },
            cache_write_tokens: {
                type: 'number',
                description: 'Tokens written to cache',
            },
            session_id: {
                type: 'string',
                description: 'Session identifier (auto-injected if omitted)',
            },
        },
        required: ['tokens_input', 'tokens_output'],
    },
};

export async function handleReportUsage(
    args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
    const { SESSION_ID } = await import('../index.js');
    const input = ReportUsageInputSchema.parse(args);
    const sessionId = input.session_id || SESSION_ID;
    const serverUrl = process.env.ORBITER_SERVER_URL || 'https://api.orbiterdev.ai';

    try {
        const response = await fetch(`${serverUrl}/api/v1/agent/usage`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({
                session_id: sessionId,
                tokens_input: input.tokens_input,
                tokens_output: input.tokens_output,
                model: input.model || 'unknown',
                cache_read_tokens: input.cache_read_tokens || 0,
                cache_write_tokens: input.cache_write_tokens || 0,
            }),
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Server responded with ${response.status}: ${text}`);
        }

        const data = await response.json() as {
            data?: {
                turn_cost_usd?: number;
                session_cost_usd?: number;
                daily_cost_usd?: number;
                budget_alert?: boolean;
                budget_message?: string;
            };
        };

        const turnCost = data?.data?.turn_cost_usd || 0;
        const sessionCost = data?.data?.session_cost_usd || 0;
        const dailyCost = data?.data?.daily_cost_usd || 0;
        const budgetAlert = data?.data?.budget_alert || false;
        const budgetMsg = data?.data?.budget_message || '';

        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    success: true,
                    message: budgetAlert
                        ? `💸 BUDGET ALERT: ${budgetMsg}`
                        : `💰 Usage recorded - Turn: $${turnCost.toFixed(4)}, Session: $${sessionCost.toFixed(4)}, Today: $${dailyCost.toFixed(2)}`,
                    data: {
                        turn_cost_usd: turnCost,
                        session_cost_usd: sessionCost,
                        daily_cost_usd: dailyCost,
                        tokens_input: input.tokens_input,
                        tokens_output: input.tokens_output,
                        model: input.model || 'unknown',
                        budget_alert: budgetAlert,
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
