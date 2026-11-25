import { z } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { getAuthHeaders } from '../utils/auth.js';
import { sseWaitForDecision } from '../utils/sse.js';
import { pollForDecision } from '../utils/poll.js';
import { detectIDE, extractWorkspaceName } from '../tools/approve.js';
import { logger } from '../logging/logger.js';
import { computeToolRisk } from '../policy/toolRisk.js';
import { redactValue } from '../codex/redaction.js';

/**
 * Claude Code Permission Notification Schema
 */
const ClaudePermissionNotificationSchema = z.object({
    permissionId: z.string(),
    source: z.string(),
    tool_name: z.string(),
    tool_input: z.unknown(),
});

type ClaudePermissionNotification = z.infer<typeof ClaudePermissionNotificationSchema>;

/**
 * Validates whether the given object is a valid Notification representation.
 */
function isPermissionNotificationObject(params: any): params is ClaudePermissionNotification {
    return (
        typeof params === 'object' &&
        params !== null &&
        typeof params.permissionId === 'string' &&
        typeof params.source === 'string' &&
        typeof params.tool_name === 'string'
    );
}

/**
 * PermissionRelayService
 * 
 * Intercepts Claude Code's native `notifications/claude/channel/permission` events
 * and relays them directly to Orbiter Dev for mobile approval, removing the need
 * for the user to inject an `ask_human` tool loop.
 */
export class PermissionRelayService {
    private server: Server;
    private serverUrl: string;

    constructor(server: Server) {
        this.server = server;
        this.serverUrl = process.env.ORBITER_SERVER_URL || 'https://api.orbiterdev.ai';
    }

    /**
     * Initializes the relay service by attaching a fallback trap to the MCP Server
     * message handler. Note: @modelcontextprotocol/sdk doesn't openly broadcast un-schemaed 
     * notifications, so we hook raw json message ingestion.
     */
    public initialize(): void {
        const isEnabled = process.env.ORBITER_PERMISSION_RELAY !== 'false';
        if (!isEnabled) {
            logger.info('[PermissionRelay] Running with CC_DM_PERMISSION_RELAY natively bypassed.');
            return;
        }

        const ClaudePermissionNotificationMethodSchema = z.object({
            method: z.literal('notifications/claude/channel/permission'),
            params: z.any()
        });

        // We hijack the server's notification hook.
        // Cast to 'any' to avoid TS2589 error with deep @modelcontextprotocol Zod types
        this.server.setNotificationHandler(ClaudePermissionNotificationMethodSchema as any, async (request: any) => {
            if (!isPermissionNotificationObject(request.params)) {
                logger.warn('[PermissionRelay] Received malformed permission notification.');
                return;
            }

            const payload = request.params as ClaudePermissionNotification;
            logger.info(`[PermissionRelay] Intercepted approval request for tool: ${payload.tool_name}`);
            
            // Fire and forget since we don't return an MCP Response for a Notification.
            this.handlePermissionRequest(payload).catch((err) => {
                logger.error('[PermissionRelay] Failed to handle permission relay request', err);
            });
        });
    }

    /**
     * Processes the permission request end-to-end
     */
    private async handlePermissionRequest(payload: ClaudePermissionNotification): Promise<void> {
        let inputJson = '{}';
        let redactedInputJson = '{}';
        try {
            inputJson = JSON.stringify(payload.tool_input, null, 2);
            // Secrets in tool input must never leave the machine (matches the other
            // surfaces): risk is computed on the raw input, the payload ships redacted.
            redactedInputJson = JSON.stringify(redactValue(payload.tool_input), null, 2);
        } catch (e) {
            inputJson = `[Unserializable Input]`;
            redactedInputJson = inputJson;
        }

        // Shared policy-as-data classifier - identical risk to the permission-check hook
        // and the Codex/Gemini rulesets for the same tool call.
        const risk = computeToolRisk(payload.tool_name, inputJson);

        // 1. Send the approval request to the Orbiter Backend
        const bodyReq = {
            action: `Allow: ${payload.tool_name}`,
            description: `Claude Code is requesting permission to run \`${payload.tool_name}\`.`,
            // ORB-32: Avoid duplicating redactedInputJson into diff_summary; backend derives wire preview on read.
            diff_summary: '',
            file_count: 0,
            risk_level: risk,
            source_ide: 'Claude Code',
            source_extension_version: 'native-relay',
            workspace_name: extractWorkspaceName(),
            auto_approve: false,
            // Custom fields specific to the Permission Relay flow
            mcp_permission_id: payload.permissionId,
            tool_name: payload.tool_name,
            tool_input_json: redactedInputJson,
        };

        try {
            const response = await fetch(`${this.serverUrl}/api/v1/approvals`, {
                method: 'POST',
                headers: getAuthHeaders(),
                body: JSON.stringify(bodyReq)
            });

            if (!response.ok) {
                const text = await response.text();
                logger.error(`[PermissionRelay] Backend Error: ${response.status} - ${text}`);
                // Fallback: deny it if we can't route it
                await this.sendResponseToClaude(payload.permissionId, 'deny');
                return;
            }

            const data: any = await response.json();
            const approvalId = data.data?.id;

            if (!approvalId) {
                logger.error('[PermissionRelay] Backend returned no approval ID');
                await this.sendResponseToClaude(payload.permissionId, 'deny');
                return;
            }

            // 2. Wait for the mobile decision
            let decisionResult: { status: string; timedOut: boolean };
            
            try {
                decisionResult = await sseWaitForDecision(this.serverUrl, approvalId.toString());
            } catch (sseErr) {
                logger.warn('[PermissionRelay] SSE failed, falling back to polling.');
                decisionResult = await pollForDecision(this.serverUrl, approvalId.toString());
            }

            // 3. Inform Claude Code
            if (decisionResult.timedOut || decisionResult.status !== 'approved') {
                await this.sendResponseToClaude(payload.permissionId, 'deny');
            } else {
                await this.sendResponseToClaude(payload.permissionId, 'allow');
            }

        } catch (err: any) {
            logger.error(`[PermissionRelay] Request execution failure: ${err.message}`);
            // Panic fail-safe 
            await this.sendResponseToClaude(payload.permissionId, 'deny');
        }
    }

    /**
     * Resolves the permission loop back into Claude Code's session.
     */
    private async sendResponseToClaude(permissionId: string, decision: 'allow' | 'deny'): Promise<void> {
        try {
            await this.server.notification({
                method: 'notifications/claude/channel/permission/response',
                params: {
                    permissionId,
                    decision
                }
            });
            logger.info(`[PermissionRelay] Returning verdict '${decision}' for permission ${permissionId}`);
        } catch (err: any) {
            logger.error(`[PermissionRelay] Failed to transmit decision to Claude Code: ${err.message}`);
        }
    }

}
