#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'crypto';
import { requestApprovalTool, handleRequestApproval } from './tools/approve.js';
import { agentHeartbeatTool, handleAgentHeartbeat } from './tools/heartbeat.js';
import { notifyUserTool, handleNotifyUser } from './tools/notify.js';
import { checkpointPostTool, handleCheckpointPost } from './tools/checkpoint.js';
import { authTool, handleAuth } from './tools/auth.js';
import { authVerifyTool, handleAuthVerify } from './tools/auth_verify.js';
import { contextHealthTool, handleContextHealth } from './tools/context_health.js';
import { reportToolResultTool, handleReportToolResult } from './tools/tool_result.js';
import { sessionMemoryTool, handleSessionMemory } from './tools/session_memory.js';
import { reportUsageTool, handleReportUsage } from './tools/usage.js';
import { killAgentTool, handleKillAgent } from './tools/kill.js';
import { getProjectInstinctsTool, addProjectInstinctTool, handleGetProjectInstincts, handleAddProjectInstinct } from './tools/project_instincts.js';
import { PermissionRelayService } from './services/permissionRelayService.js';
import { logger } from './logging/logger.js';
import { MCP_PACKAGE_VERSION } from './version.js';

// Auto-generated session UUID - injected into heartbeat/checkpoint calls
// so callers never need to provide or guess one
export const SESSION_ID = randomUUID();

/**
 * Orbiter Dev MCP Server
 *
 * Exposes core mobile approval, pairing, and status tools by default.
 * Opt in to legacy telemetry and memory tools with --legacy-tools or
 * ORBITER_ENABLE_LEGACY_TOOLS=1.
 */

const SERVER_NAME = 'orbiter-dev-mcp';
const SERVER_VERSION = MCP_PACKAGE_VERSION;

export const CORE_TOOLS = [
    requestApprovalTool,
    authTool,
    authVerifyTool,
    notifyUserTool,
    killAgentTool,
];

export const LEGACY_TOOLS = [
    agentHeartbeatTool,
    checkpointPostTool,
    contextHealthTool,
    reportToolResultTool,
    sessionMemoryTool,
    reportUsageTool,
    getProjectInstinctsTool,
    addProjectInstinctTool,
];

const LEGACY_TOOL_NAMES = new Set(LEGACY_TOOLS.map((tool) => tool.name));

export function isLegacyToolsEnabled(
    argv: string[] = process.argv,
    env: NodeJS.ProcessEnv = process.env
): boolean {
    if (argv.includes('--legacy-tools')) {
        return true;
    }
    const raw = (env.ORBITER_ENABLE_LEGACY_TOOLS || '').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes';
}

export function getRegisteredTools(
    argv: string[] = process.argv,
    env: NodeJS.ProcessEnv = process.env
) {
    return isLegacyToolsEnabled(argv, env)
        ? [...CORE_TOOLS, ...LEGACY_TOOLS]
        : [...CORE_TOOLS];
}

async function main(): Promise<void> {
    // CLI Command Handling
    if (process.argv.includes('notify')) {
        const args = process.argv.slice(process.argv.indexOf('notify') + 1);
        const { handleNotifyCommand } = await import('./commands/notify.js');
        await handleNotifyCommand(args);
        return;
    }

    // CLI Permission-Check Fallback Handling
    if (process.argv.includes('permission-check')) {
        const args = process.argv.slice(process.argv.indexOf('permission-check') + 1);
        const { handlePermissionCheckCommand } = await import('./cli/permissionCheck.js');
        await handlePermissionCheckCommand(args);
        return;
    }

    if (process.argv.includes('codex')) {
        const args = process.argv.slice(process.argv.indexOf('codex') + 1);
        const { handleCodexConfigCommand } = await import('./commands/codexConfig.js');
        await handleCodexConfigCommand(args);
        return;
    }

    if (process.argv.includes('codex-hook')) {
        const args = process.argv.slice(process.argv.indexOf('codex-hook') + 1);
        const { handleCodexHookCommand } = await import('./commands/codexHook.js');
        await handleCodexHookCommand(args);
        return;
    }

    if (process.argv.includes('codex-app-server')) {
        const args = process.argv.slice(process.argv.indexOf('codex-app-server') + 1);
        const { handleCodexAppServerCommand } = await import('./commands/codexAppServer.js');
        await handleCodexAppServerCommand(args);
        return;
    }

    if (process.argv.includes('antigravity')) {
        const args = process.argv.slice(process.argv.indexOf('antigravity') + 1);
        const { handleAntigravityConfigCommand } = await import('./commands/antigravityConfig.js');
        await handleAntigravityConfigCommand(args);
        return;
    }

    if (process.argv.includes('antigravity-hook')) {
        const args = process.argv.slice(process.argv.indexOf('antigravity-hook') + 1);
        const { handleAntigravityHookCommand } = await import('./commands/antigravityHook.js');
        await handleAntigravityHookCommand(args);
        return;
    }

    if (process.argv.includes('gemini')) {
        const args = process.argv.slice(process.argv.indexOf('gemini') + 1);
        const { handleGeminiConfigCommand } = await import('./commands/geminiConfig.js');
        await handleGeminiConfigCommand(args);
        return;
    }

    if (process.argv.includes('gemini-hook')) {
        const args = process.argv.slice(process.argv.indexOf('gemini-hook') + 1);
        const { handleGeminiHookCommand } = await import('./commands/geminiHook.js');
        await handleGeminiHookCommand(args);
        return;
    }

    if (process.argv.includes('claude')) {
        const args = process.argv.slice(process.argv.indexOf('claude') + 1);
        const { handleClaudeConfigCommand } = await import('./commands/claudeConfig.js');
        await handleClaudeConfigCommand(args);
        return;
    }

    console.error(`Starting ${SERVER_NAME} v${SERVER_VERSION}...`);

    const server = new Server(
        {
            name: SERVER_NAME,
            version: SERVER_VERSION,
        },
        {
            capabilities: {
                tools: {},
            },
        }
    );

    // Initialize Permission Relay Service
    const permissionRelay = new PermissionRelayService(server);
    permissionRelay.initialize();

    const legacyToolsEnabled = isLegacyToolsEnabled(process.argv, process.env);

    // Handle tool listing
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        return {
            tools: getRegisteredTools(process.argv, process.env),
        };
    });

    // Handle tool execution
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;

        if (LEGACY_TOOL_NAMES.has(name) && !legacyToolsEnabled) {
            throw new Error(
                `Tool "${name}" is a legacy tool and is disabled by default. Pass --legacy-tools or set ORBITER_ENABLE_LEGACY_TOOLS=1 to enable it.`
            );
        }

        switch (name) {
            case 'request_approval':
                return handleRequestApproval(args);

            case 'agent_heartbeat':
                return handleAgentHeartbeat(args);

            case 'notify_user':
                return handleNotifyUser(args);

            case 'checkpoint_post':
                return handleCheckpointPost(args);

            case 'orbiter_auth':
                return handleAuth(args);

            case 'orbiter_auth_verify':
                return handleAuthVerify(args);

            case 'context_health':
                return handleContextHealth(args);

            case 'report_tool_result':
                return handleReportToolResult(args);

            case 'session_memory':
                return handleSessionMemory(args);

            case 'report_usage':
                return handleReportUsage(args);

            case 'kill_agent':
                return handleKillAgent(args);

            case 'get_project_instincts':
                return handleGetProjectInstincts(args);

            case 'add_project_instinct':
                return handleAddProjectInstinct(args);

            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    });

    // Connect via stdio transport
    const transport = new StdioServerTransport();
    await server.connect(transport);

    logger.info(`${SERVER_NAME} connected and ready`);
    console.error(`${SERVER_NAME} connected and ready`);
}

if (require.main === module) {
    main().catch((error) => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
}
