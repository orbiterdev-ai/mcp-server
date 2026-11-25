import { z } from 'zod';
import { getAuthHeaders } from '../utils/auth.js';

/**
 * Project Instincts Tool (Sprint 33: F31)
 *
 * Exposes Orbiter Dev's Project-Scoped Instinct API.
 * This allows agents to persist knowledge, architectural patterns,
 * and gotchas securely for the current workspace hash, preventing hallucination loops.
 */

// --- Schemas ---

const GetInstinctsInputSchema = z.object({
    workspace_hash: z.string().describe('The git or workspace hash for pattern scoping. If unsure, use "global".'),
});

const AddInstinctInputSchema = z.object({
    workspace_hash: z.string().describe('The git or workspace hash. Use "global" if repository context is unavailable.'),
    pattern_type: z.enum(['bug_avoidance', 'architectural_pattern', 'workflow_preference', 'dependency_rules']).describe('The category of the instinct.'),
    description: z.string().describe('Detailed description of the learned pattern, best practice, or gotcha.'),
});

type GetInstinctsInput = z.infer<typeof GetInstinctsInputSchema>;
type AddInstinctInput = z.infer<typeof AddInstinctInputSchema>;

// --- Tool Definitions ---

export const getProjectInstinctsTool = {
    name: 'get_project_instincts',
    description: `Retrieve learned project-scoped patterns and rules for the workspace.
Always call this tool at the start of complex tasks or when you encounter errors you suspect have been solved before.
This serves as "Long-Term Memory" across disparate agent sessions.`,
    inputSchema: {
        type: 'object',
        properties: {
            workspace_hash: {
                type: 'string',
                description: 'The git or workspace hash for pattern scoping. If unsure, use "global".',
            },
        },
        required: ['workspace_hash'],
    },
};

export const addProjectInstinctTool = {
    name: 'add_project_instinct',
    description: `Save a new learning or architectural pattern to the project's Long-Term Memory.
Call this when you discover:
- A non-obvious solution to a difficult bug
- Specific architectural requirements the user enforces
- Undocumented dependency constraints
This knowledge will be served to all future agents.`,
    inputSchema: {
        type: 'object',
        properties: {
            workspace_hash: {
                type: 'string',
                description: 'The git or workspace hash. Use "global" if repository context is unavailable.',
            },
            pattern_type: {
                enum: ['bug_avoidance', 'architectural_pattern', 'workflow_preference', 'dependency_rules'],
                type: 'string',
                description: 'The category of the instinct',
            },
            description: {
                type: 'string',
                description: 'Detailed description of the learned pattern, best practice, or gotcha.',
            },
        },
        required: ['workspace_hash', 'pattern_type', 'description'],
    },
};

// --- Handlers ---

export async function handleGetProjectInstincts(
    args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
    const input = GetInstinctsInputSchema.parse(args);
    const serverUrl = process.env.ORBITER_SERVER_URL || 'https://api.orbiterdev.ai';

    try {
        const response = await fetch(`${serverUrl}/api/v1/instincts?workspace_hash=${encodeURIComponent(input.workspace_hash)}`, {
            method: 'GET',
            headers: getAuthHeaders(),
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Server responded with ${response.status}: ${text}`);
        }

        const data = await response.json() as Record<string, unknown>;

        return {
            content: [{
                type: 'text',
                text: JSON.stringify(data, null, 2),
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
                    hint: 'Ensure Orbiter Backend is running and you have authenticated.',
                }, null, 2),
            }],
        };
    }
}

export async function handleAddProjectInstinct(
    args: unknown
): Promise<{ content: Array<{ type: string; text: string }> }> {
    const input = AddInstinctInputSchema.parse(args);
    const serverUrl = process.env.ORBITER_SERVER_URL || 'https://api.orbiterdev.ai';

    try {
        const response = await fetch(`${serverUrl}/api/v1/instincts`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({
                workspace_hash: input.workspace_hash,
                pattern_type: input.pattern_type,
                description: input.description,
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
                    message: `✅ Instinct saved to Long-Term Memory.`,
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
                    hint: 'Ensure Orbiter Backend is running and you have authenticated.',
                }, null, 2),
            }],
        };
    }
}
