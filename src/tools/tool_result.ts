import { z } from 'zod';
import { getAuthHeaders } from '../utils/auth.js';

/**
 * Report Tool Result (Sprint 25: F12 - Loop Detection)
 * 
 * Inspired by Claude Code's circuit breaker pattern:
 *   maxConsecutiveAutocompactFailures = 3  // stops after 3 failures
 * 
 * Agents report tool execution results. The backend detects patterns:
 * - Same error 3+ times → push "Agent stuck"
 * - Same file edited 5+ times → push "Agent churning"
 * - API call repeated 10+ times → push "Runaway loop"
 */

const ToolResultInputSchema = z.object({
    tool_name: z.string()
        .describe('Name of the tool that was executed (e.g., "FileEdit", "Bash", "WebSearch")'),
    success: z.boolean()
        .describe('Whether the tool execution succeeded'),
    error_message: z.string().optional()
        .describe('Error message if the tool failed'),
    file_path: z.string().optional()
        .describe('File path that was operated on (for file-related tools)'),
    duration_ms: z.number().optional()
        .describe('Execution duration in milliseconds'),
    session_id: z.string().optional()
        .describe('Session identifier (auto-injected if omitted)'),
});

type ToolResultInput = z.infer<typeof ToolResultInputSchema>;

export const reportToolResultTool = {
    name: 'report_tool_result',
    description: `Report the result of a tool execution to Orbiter Dev for loop detection.

Call this tool after executing potentially risky or repeatable operations.
Orbiter Dev will detect patterns that indicate the agent is stuck:
- Same error 3+ times → User gets push: "Agent stuck - Kill?"
- Same file edited 5+ times → User gets push: "Agent churning"
- API retries 10+ times → User gets push: "Runaway loop detected"

This prevents wasted compute and protects the user's codebase from churn.`,
    inputSchema: {
        type: 'object',
        properties: {
            tool_name: {
                type: 'string',
                description: 'Name of the tool executed',
            },
            success: {
                type: 'boolean',
                description: 'Whether the execution succeeded',
            },
            error_message: {
                type: 'string',
                description: 'Error message if failed',
            },
            file_path: {
                type: 'string',
                description: 'File path operated on',
            },
            duration_ms: {
                type: 'number',
                description: 'Execution duration in milliseconds',
            },
            session_id: {
                type: 'string',
                description: 'Session identifier (auto-injected if omitted)',
            },
        },
        required: ['tool_name', 'success'],
    },
};

export async function handleReportToolResult(
    args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
    const { SESSION_ID } = await import('../index.js');
    const input = ToolResultInputSchema.parse(args);
    const sessionId = input.session_id || SESSION_ID;
    const serverUrl = process.env.ORBITER_SERVER_URL || 'https://api.orbiterdev.ai';

    try {
        const response = await fetch(`${serverUrl}/api/v1/agent/tool-result`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({
                session_id: sessionId,
                tool_name: input.tool_name,
                success: input.success,
                error_message: input.error_message || '',
                file_path: input.file_path || '',
                duration_ms: input.duration_ms || 0,
            }),
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Server responded with ${response.status}: ${text}`);
        }

        const data = await response.json() as {
            data?: {
                loop_detected?: boolean;
                loop_type?: string;
                recommendation?: string;
            };
        };

        // Check if backend detected a loop
        const loopDetected = data?.data?.loop_detected || false;
        const loopType = data?.data?.loop_type || '';
        const recommendation = data?.data?.recommendation || '';

        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    success: true,
                    message: loopDetected
                        ? `⚠️ LOOP DETECTED (${loopType}): ${recommendation}`
                        : 'Tool result recorded',
                    loop_detected: loopDetected,
                    loop_type: loopType,
                    recommendation,
                    data,
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
