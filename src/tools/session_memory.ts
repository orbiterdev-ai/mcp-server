import { z } from 'zod';
import { getAuthHeaders } from '../utils/auth.js';

/**
 * Session Memory Tool (Sprint 25: F03)
 * 
 * Inspired by Claude Code's compact prompt 9-section summary template:
 *   1. Primary Request and Intent
 *   2. Key Technical Concepts
 *   3. Files and Code Sections
 *   4. Errors and Fixes
 *   5. Problem Solving
 *   6. All user messages
 *   7. Pending Tasks
 *   8. Current Work
 *   9. Optional Next Step
 * 
 * Agents save structured session state. Users can browse sessions
 * from their phone and resume where they left off.
 */

const SessionMemoryInputSchema = z.object({
    primary_request: z.string()
        .describe('What the user originally asked for - the primary intent'),
    key_concepts: z.string().optional()
        .describe('Key technical concepts and context relevant to the task'),
    files_touched: z.array(z.string()).optional()
        .describe('List of files that were read, modified, or created'),
    errors_and_fixes: z.string().optional()
        .describe('Summary of errors encountered and how they were resolved'),
    pending_tasks: z.array(z.string()).optional()
        .describe('Tasks that remain to be completed'),
    current_work: z.string().optional()
        .describe('What was being worked on when the memory was saved'),
    next_step: z.string().optional()
        .describe('Suggested next action to resume the session'),
    session_id: z.string().optional()
        .describe('Session identifier (auto-injected if omitted)'),
});

type SessionMemoryInput = z.infer<typeof SessionMemoryInputSchema>;

export const sessionMemoryTool = {
    name: 'session_memory',
    description: `Save a structured snapshot of the current session state to Orbiter Dev.

Use this tool to persist session context so the user can resume later:
- Call before context compaction to preserve what was being worked on
- Call at natural breakpoints (feature complete, error resolved)
- Call when switching to a different task

The user can browse session history on their phone and tap "Resume"
to get a continuation prompt. This prevents progress loss from
context window exhaustion or session disconnects.

Structure your memory using the provided fields for best results.`,
    inputSchema: {
        type: 'object',
        properties: {
            primary_request: {
                type: 'string',
                description: 'What the user originally asked for',
            },
            key_concepts: {
                type: 'string',
                description: 'Key technical concepts and context',
            },
            files_touched: {
                type: 'array',
                items: { type: 'string' },
                description: 'Files read, modified, or created',
            },
            errors_and_fixes: {
                type: 'string',
                description: 'Errors encountered and their resolutions',
            },
            pending_tasks: {
                type: 'array',
                items: { type: 'string' },
                description: 'Remaining tasks',
            },
            current_work: {
                type: 'string',
                description: 'What was being worked on when saved',
            },
            next_step: {
                type: 'string',
                description: 'Suggested next action to resume',
            },
            session_id: {
                type: 'string',
                description: 'Session identifier (auto-injected if omitted)',
            },
        },
        required: ['primary_request'],
    },
};

export async function handleSessionMemory(
    args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
    const { SESSION_ID } = await import('../index.js');
    const input = SessionMemoryInputSchema.parse(args);
    const sessionId = input.session_id || SESSION_ID;
    const serverUrl = process.env.ORBITER_SERVER_URL || 'https://api.orbiterdev.ai';

    try {
        const response = await fetch(`${serverUrl}/api/v1/agent/session-memory`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({
                session_id: sessionId,
                primary_request: input.primary_request,
                key_concepts: input.key_concepts || '',
                files_touched: input.files_touched || [],
                errors_and_fixes: input.errors_and_fixes || '',
                pending_tasks: input.pending_tasks || [],
                current_work: input.current_work || '',
                next_step: input.next_step || '',
            }),
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Server responded with ${response.status}: ${text}`);
        }

        const data = await response.json() as Record<string, unknown>;

        const taskCount = input.pending_tasks?.length || 0;
        const fileCount = input.files_touched?.length || 0;

        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    success: true,
                    message: `📝 Session memory saved (${fileCount} files, ${taskCount} pending tasks)`,
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
