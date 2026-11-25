import { z } from 'zod';
import { getAuthHeaders } from '../utils/auth.js';

/**
 * Checkpoint Post Tool (MCP-011)
 * 
 * Logs structured progress checkpoints to the Orbiter backend.
 * These appear as a timeline on the user's mobile app.
 */

const CheckpointInputSchema = z.object({
    session_id: z.string().uuid().optional()
        .describe('Auto-generated session UUID (do not provide - injected automatically)'),
    step_number: z.number().int().positive().describe('Current step number'),
    total_steps: z.number().int().positive().describe('Total number of steps'),
    risk: z.enum(['low', 'yellow', 'red']).optional().default('low')
        .describe('Risk level of this step'),
    changed_files: z.array(z.string()).optional().default([])
        .describe('Files modified in this step'),
    verify_commands: z.array(z.string()).optional().default([])
        .describe('Commands to verify this step'),
    next_action: z.string().optional()
        .describe('What happens next after this checkpoint'),
});

type CheckpointInput = z.infer<typeof CheckpointInputSchema>;

export const checkpointPostTool = {
    name: 'checkpoint_post',
    description: `Log a structured progress checkpoint to Orbiter Dev.

Use this tool to report progress through a multi-step task:
- After completing each major step
- When risk level changes (e.g., about to delete files)
- To show the user what files were changed and how to verify

The user sees these as a visual timeline on their mobile app,
helping them track agent progress and verify work.`,
    inputSchema: {
        type: 'object',
        properties: {
            step_number: {
                type: 'number',
                description: 'Current step (e.g., 3)',
            },
            total_steps: {
                type: 'number',
                description: 'Total steps (e.g., 5)',
            },
            risk: {
                type: 'string',
                enum: ['low', 'yellow', 'red'],
                description: 'Risk level of this step',
                default: 'low',
            },
            changed_files: {
                type: 'array',
                items: { type: 'string' },
                description: 'Files modified in this step',
            },
            verify_commands: {
                type: 'array',
                items: { type: 'string' },
                description: 'Commands to verify this step (e.g., "go test ./...")',
            },
            next_action: {
                type: 'string',
                description: 'What the agent will do next',
            },
        },
        required: ['step_number', 'total_steps'],
    },
};

export async function handleCheckpointPost(
    args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
    // Lazy import to avoid circular dependency
    const { SESSION_ID } = await import('../index.js');
    
    const input = CheckpointInputSchema.parse(args);
    const sessionId = input.session_id || SESSION_ID;
    const serverUrl = process.env.ORBITER_SERVER_URL || 'https://api.orbiterdev.ai';

    try {
        const response = await fetch(`${serverUrl}/api/v1/checkpoints`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({
                session_id: sessionId,
                step_number: input.step_number,
                total_steps: input.total_steps,
                risk: input.risk,
                changed_files: input.changed_files,
                verify_commands: input.verify_commands,
                next_action: input.next_action || '',
            }),
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Server responded with ${response.status}: ${text}`);
        }

        const data: any = await response.json();

        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    success: true,
                    message: `Checkpoint ${input.step_number}/${input.total_steps} logged`,
                    data,
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
                    hint: 'Ensure Orbiter Backend is running and /checkpoints endpoint exists',
                }, null, 2),
            }],
        };
    }
}
