import { getAuthHeaders } from '../utils/auth.js';
import { sseWaitForDecision } from '../utils/sse.js';
import { pollForDecision } from '../utils/poll.js';
import { logger } from '../logging/logger.js';
import { loadCredentials, type OrbiterCredentials } from '../auth/credentials.js';
import { computeToolRisk } from '../policy/toolRisk.js';
import { isTrustedOrbiterInternalTool } from '../policy/internalTools.js';
import { meetsMinRisk, resolveMinRisk } from '../policy/ruleset.js';
import { redactValue, redactString } from '../codex/redaction.js';

/**
 * Claude Code PermissionRequest Hook Handler
 * 
 * This script is invoked by Claude Code's hooks system before any tool
 * permission dialog is shown. It receives the tool request via stdin JSON
 * and must output a JSON decision to stdout.
 * 
 * Protocol (per Claude Code spec):
 *   Exit 0 + JSON stdout → parsed as allow/deny decision
 *   Exit 2 + stderr      → hard deny, stderr shown to Claude
 *   Other exit codes      → non-blocking fallthrough to native prompt
 * 
 * Output format:
 *   {
 *     "hookSpecificOutput": {
 *       "hookEventName": "PermissionRequest",
 *       "decision": { "behavior": "allow" | "deny", "message"?: "reason" }
 *     }
 *   }
 * 
 * Stdin format (from Claude Code):
 *   {
 *     "hook_event_name": "PermissionRequest",
 *     "tool_name": "Bash",
 *     "tool_input": { "command": "..." },
 *     "cwd": "/path/to/project",
 *     "session_id": "abc123"
 *   }
 */

// ─── JSON Output Helpers ────────────────────────────────────────────

function makeAllowOutput(): string {
    // Per the Claude Code PermissionRequest contract, `message` is a deny-only field;
    // allow decisions carry only `behavior` (plus optional updatedInput/updatedPermissions).
    return JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: { behavior: 'allow' },
        },
    });
}

function makeDenyOutput(reason: string): string {
    return JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: { behavior: 'deny', message: reason },
        },
    });
}

/**
 * Write the hook's JSON decision to stdout, then exit AFTER the payload has flushed.
 * Calling process.exit() right after process.stdout.write() can truncate or drop the
 * decision when stdout is in async mode (e.g. a backed-up pipe), which would make Claude
 * see empty output. Exiting from the write callback guarantees the bytes are handed to the
 * OS first; process.exitCode is set as a belt-and-suspenders fallback. Callers must `return`
 * after this so synchronous execution stops (exit fires asynchronously).
 */
function emitDecisionAndExit(json: string, code: number): void {
    process.exitCode = code;
    process.stdout.write(json, () => process.exit(code));
}

// ─── Orbiter Self-Tool Passthrough ─────────────────────────────────
// These are Orbiter's own allowlisted internal MCP tools. The hook must NOT
// intercept them or it creates a phantom approval card before every real one.
const PRODUCTION_API_URL = 'https://api.orbiterdev.ai';

function isOrbiterTool(toolName: string): boolean {
    return isTrustedOrbiterInternalTool(toolName);
}

// ─── Main Hook Handler ──────────────────────────────────────────────

export async function handlePermissionCheckCommand(args: string[]) {
    // 1. Read stdin (Claude Code pipes the tool request as JSON)
    let stdinData = '';
    try {
        if (!process.stdin.isTTY) {
            process.stdin.setEncoding('utf8');
            for await (const chunk of process.stdin) {
                stdinData += chunk;
            }
        }
    } catch (e) {
        // stdin read failure - fallthrough to Claude native prompt
    }

    let toolName = 'Unknown Tool';
    let toolInput = '{}';
    // Claude Code sends `cwd` in the stdin JSON, NOT via env vars.
    // All context comes via stdin - ref: docs/research/claude-code-permission-hooks.md#L25
    let workspaceName = 'unknown';

    if (stdinData) {
        try {
            const parsed = JSON.parse(stdinData);
            toolName = parsed.tool_name || parsed.tool || toolName;
            toolInput = parsed.tool_input
                ? JSON.stringify(parsed.tool_input)
                : parsed.properties
                    ? JSON.stringify(parsed.properties)
                    : '{}';
            // Extract workspace from stdin cwd (e.g. "/home/user/myproject" → "myproject")
            if (parsed.cwd && typeof parsed.cwd === 'string') {
                const parts = parsed.cwd.replace(/\\/g, '/').split('/').filter(Boolean);
                workspaceName = parts[parts.length - 1] || parsed.cwd;
            }
            logger.info(`[PermissionCheck] Hook invoked for tool: ${toolName} in ${workspaceName}`);
        } catch (e) {
            logger.warn(`[PermissionCheck] Failed to parse stdin JSON: ${e}`);
        }
    } else {
        // Fallback: parse basic CLI args
        for (let i = 0; i < args.length; i++) {
            if (args[i] === '--tool' && args[i + 1]) {
                toolName = args[i + 1];
                i++;
            } else if (args[i] === '--input' && args[i + 1]) {
                toolInput = args[i + 1];
                i++;
            }
        }
    }

    // ── Passthrough: Never intercept Orbiter's own tools ──────────────
    // When Claude calls request_approval, the hook fires for THAT call too.
    // Without this guard, every approval creates a phantom low-risk
    // "Allow: mcp__orbiter__request_approval" noise card BEFORE the real one.
    if (isOrbiterTool(toolName)) {
        logger.info(`[PermissionCheck] Passthrough (Orbiter tool): ${toolName}`);
        emitDecisionAndExit(makeAllowOutput(), 0);
        return;
    }

    const credentials = loadCredentials();
    const serverUrl = resolvePermissionCheckServerUrl(credentials);
    // Shared policy-as-data classifier - same ruleset as the Codex/Gemini hooks, so the
    // same command gets the same risk on every surface (ORBITER_HOOK_POLICY=legacy reverts).
    // Risk is computed over the RAW input (accuracy), but what leaves this machine is
    // redacted, matching the Codex/Gemini/Antigravity surfaces: secrets in tool input
    // (tokens, keys, bearer headers) must never reach the backend or the phone.
    const risk = computeToolRisk(toolName, toolInput);
    const redactedToolInput = redactToolInputJson(toolInput);

    // ── B-118: shared risk threshold ──────────────────────────────────
    // Historically Claude Code had NO risk gate: matcher "*" plus no threshold meant every
    // permissioned call became a phone push, while Codex/Gemini escalated only high+critical.
    // The default stays 'low' so unset ORBITER_MIN_RISK preserves that behavior exactly;
    // set ORBITER_MIN_RISK=high for Codex-style quiet. 'critical' always escalates.
    const minRisk = resolveMinRisk('low');
    if (!meetsMinRisk(risk, minRisk)) {
        logger.info(`[PermissionCheck] Below ORBITER_MIN_RISK (${risk} < ${minRisk}) - allowing locally: ${toolName}`);
        emitDecisionAndExit(makeAllowOutput(), 0);
        return;
    }

    logger.info(`[PermissionCheck] Requesting approval for tool: ${toolName} (risk: ${risk}, min: ${minRisk})`);

    // 2. Submit approval request to Orbiter backend
    // Note: source_ide is hardcoded to 'claude_code' because ONLY Claude Code
    // invokes hooks. Environment-based detection (detectIDE()) fails in hook
    // context because Claude Code does NOT set env vars for child processes.
    const bodyReq = {
        action: `Allow: ${toolName}`,
        description: `Claude Code is requesting permission to run \`${toolName}\`.`,
        // ORB-32: Avoid duplicating redactedToolInput into diff_summary; backend derives wire preview on read.
        diff_summary: '',
        file_count: 0,
        risk_level: risk,
        source_ide: 'Claude Code',
        source_extension_version: 'hook-v2',
        workspace_name: workspaceName,
        auto_approve: false,
        mcp_permission_id: `hook_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
        tool_name: toolName,
        tool_input_json: redactedToolInput,
    };

    try {
        const response = await fetch(`${serverUrl}/api/v1/approvals`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify(bodyReq),
        });

        if (!response.ok) {
            const text = await response.text();
            console.error(`[Orbiter Dev] Backend returned ${response.status}: ${text}`);
            // Graceful fallthrough → Claude shows native permission prompt
            process.exit(1);
        }

        const data: any = await response.json();
        const approvalId = data.data?.id;

        if (!approvalId) {
            console.error('[Orbiter Dev] Backend returned no approval ID - falling through to native prompt.');
            process.exit(1);
        }

        // 3. Wait for mobile decision (SSE first, polling fallback)
        console.error(`\n⏳ Orbiter Dev: Waiting for mobile approval for '${toolName}'...`);

        let decisionResult: { status: string; notes: string; timedOut: boolean };
        try {
            decisionResult = await sseWaitForDecision(serverUrl, approvalId.toString());
        } catch (sseErr) {
            logger.warn('[PermissionCheck] SSE failed, falling back to polling.');
            decisionResult = await pollForDecision(serverUrl, approvalId.toString());
        }

        // 4. Return decision to Claude Code
        if (decisionResult.timedOut) {
            console.error('\n⏱️ Orbiter Dev: Approval timed out.');
            emitDecisionAndExit(makeDenyOutput('Timed out waiting for mobile approval (5 min). Retry or ask the user directly.'), 0);
            return;
        }

        if (decisionResult.status === 'approved') {
            console.error('\n✅ Orbiter Dev: Approved by user.');
            emitDecisionAndExit(makeAllowOutput(), 0);
            return;
        } else {
            console.error('\n❌ Orbiter Dev: Denied by user.');
            emitDecisionAndExit(makeDenyOutput(decisionResult.notes || 'User manually rejected on Orbiter Dev mobile app.'), 0);
            return;
        }

    } catch (err: any) {
        // Network error / backend unreachable → graceful fallthrough
        logger.error(`[PermissionCheck] Failure: ${err.message}`);
        console.error(`[Orbiter Dev] Backend unreachable (${err.message}) - falling through to native prompt.`);
        // Exit 1 = non-blocking fallthrough. Claude shows its native prompt.
        process.exit(1);
    }
}

export function resolvePermissionCheckServerUrl(credentials: OrbiterCredentials | null): string {
    const envUrl = process.env.ORBITER_SERVER_URL?.trim();
    if (envUrl) return envUrl.replace(/\/+$/, '');

    const credentialUrl = credentials?.backend_url?.trim();
    if (credentialUrl) return credentialUrl.replace(/\/+$/, '');

    return PRODUCTION_API_URL;
}

// Risk assessment lives in ../policy/toolRisk.ts (shared with the permission relay and
// backed by the same DEFAULT_RISK_RULESET the Codex/Gemini hooks interpret).

/**
 * Redact a raw tool-input JSON string before it leaves the machine: parse and redact
 * structurally when possible (key- and value-based rules), fall back to string-level
 * redaction for non-JSON input. Mirrors what the Codex/Gemini/Antigravity normalizers
 * already do with `redactValue` before building their approval requests.
 */
export function redactToolInputJson(inputJson: string): string {
    try {
        const parsed = JSON.parse(inputJson) as unknown;
        return JSON.stringify(redactValue(parsed));
    } catch {
        return redactString(inputJson);
    }
}
