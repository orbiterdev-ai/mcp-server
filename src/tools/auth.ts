import { z } from 'zod';
import { loadCredentials, validateCredentials, getCredentialPath } from '../auth/credentials.js';
import * as fs from 'fs';
import * as os from 'os';

export const authTool = {
    name: "orbiter_auth",
    description: `Start or check workspace pairing with your Orbiter Dev mobile app (iOS and Android).

When to use:
- Call once during initial setup or whenever another Orbiter tool reports missing or expired credentials.
- Pass the mobile pairing code (from Settings -> Pair IDE on the Orbiter Dev mobile app, e.g., "ORBIT-K7N3") in \`code\` to claim it and trigger a confirmation prompt on the user's phone.
- Omit \`code\` to verify whether the workspace is already paired (via \`ORBITER_TOKEN\` or valid \`~/.orbiter/credentials\`) or to retrieve step-by-step instructions for generating a code.

Next step: After claiming a code, call \`orbiter_auth_verify\` with the returned \`device_code\` to complete pairing and save local credentials.

Returns JSON with:
- On code claimed: \`{ success: true, status: "awaiting_confirmation", pair_code, device_code, expires_in, message }\` where \`expires_in\` is the code expiry window in seconds (default 300s / 5 minutes).
- If already authenticated: \`{ success: true, status: "already_paired", message }\`.
- If \`code\` is omitted and not yet paired: \`{ success: false, status: "code_required", message }\` with setup instructions.

Expiry & error recovery: Pairing codes expire after 5 minutes (300s) and are single-use. If a code is invalid, already claimed, or expired (HTTP 400/404), or if a network error occurs, returns structured non-throwing JSON with \`{ success: false, error, hint }\`. Ask the user to generate a new code under Settings -> Pair IDE and re-run \`orbiter_auth\`.`,
    annotations: {
        title: "Pair Orbiter Mobile App",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
    },
    inputSchema: {
        type: "object",
        properties: {
            code: {
                type: "string",
                minLength: 1,
                description: "Optional short-lived pairing code displayed in the Orbiter Dev mobile app under Settings -> Pair IDE (e.g., \"ORBIT-K7N3\" or suffix \"K7N3\"; case-insensitive, automatically trimmed and prefixed). Omit to check existing credentials or retrieve pairing instructions."
            }
        }
    }
};

export async function handleAuth(args: unknown): Promise<{ content: Array<{ type: string; text: string }> }> {
    const inputSchema = z.object({
        code: z.string().optional()
    });
    const input = inputSchema.parse(args ?? {});

    const backendUrl = (
        process.env.ORBITER_API_URL ||
        process.env.ORBITER_SERVER_URL ||
        'https://api.orbiterdev.ai'
    ).replace(/\/+$/, '');

    // 1. Check if already authenticated via env var
    const envToken = process.env.ORBITER_TOKEN;
    if (envToken) {
        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    success: true,
                    status: 'already_paired',
                    message: 'Already paired via ORBITER_TOKEN environment variable.',
                }, null, 2)
            }]
        };
    }

    // Check existing credentials
    const creds = loadCredentials();
    if (creds) {
        const isValid = await validateCredentials(creds);
        if (isValid) {
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        success: true,
                        status: 'already_paired',
                        message: 'Already paired using stored local credentials.',
                    }, null, 2)
                }]
            };
        } else {
            // Remove invalid creds
            try {
                if (fs.existsSync(getCredentialPath())) {
                   fs.unlinkSync(getCredentialPath());
                }
            } catch {
                // Ignore cleanup failure
            }
        }
    }

    // If no code provided, ask the user to get one from their phone
    if (!input.code || !input.code.trim()) {
        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    success: false,
                    status: 'code_required',
                    message: 'No pairing code provided. Ask the user to open the Orbiter Dev mobile app (iOS or Android), go to Settings -> Pair IDE, read the 5-minute code (e.g., ORBIT-K7N3), and call orbiter_auth again with the code parameter.',
                }, null, 2)
            }]
        };
    }

    try {
        // Normalize the code
        let code = input.code.trim().toUpperCase();
        // If user provides just the suffix (e.g. "K7N3"), add the ORBIT- prefix
        if (!code.startsWith('ORBIT-') && code.length <= 6) {
            code = `ORBIT-${code}`;
        }

        // Gather IDE identity
        const ideName = detectIdeName();
        const ideHostname = os.hostname();
        const ideOs = `${os.type()} ${os.release()}`;

        // Claim the code with IDE identity
        const claimResponse = await fetch(`${backendUrl}/api/v1/auth/ide/claim`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user_code: code,
                ide_name: ideName,
                ide_hostname: ideHostname,
                ide_os: ideOs
            })
        });
        
        if (!claimResponse.ok) {
            const errJson = await claimResponse.json().catch(() => ({})) as Record<string, unknown>;
            const errMsg = errJson?.error || 'Invalid or expired pairing code';
            throw new Error(typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg));
        }

        const jsonResponse = await claimResponse.json() as Record<string, unknown>;
        const data = (jsonResponse.data && typeof jsonResponse.data === 'object'
            ? jsonResponse.data
            : jsonResponse) as Record<string, unknown>;
        const device_code = typeof data.device_code === 'string' ? data.device_code : '';
        const expires_in = typeof data.expires_in === 'number' && Number.isFinite(data.expires_in)
            ? data.expires_in
            : 300;
        const status = typeof data.status === 'string' ? data.status : 'awaiting_confirmation';

        if (!device_code) {
            throw new Error('Backend claim response did not include a device_code');
        }

        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    success: true,
                    status,
                    pair_code: code,
                    device_code,
                    expires_in,
                    message: `Pairing code ${code} claimed (expires in ${expires_in}s). Ask the user to tap "Allow" in the Orbiter Dev mobile app, then call orbiter_auth_verify with device_code "${device_code}".`,
                }, null, 2)
            }]
        };

    } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        return {
            content: [{
                type: 'text',
                text: JSON.stringify({
                    success: false,
                    error: errorMessage,
                    hint: 'Generate a fresh pairing code in the Orbiter Dev mobile app (Settings -> Pair IDE) and call orbiter_auth again.',
                }, null, 2)
            }]
        };
    }
}

/**
 * Detect which IDE is running this MCP server
 */
function detectIdeName(): string {
    const explicitIdeName = process['env'].ORBITER_IDE_NAME?.trim();
    if (explicitIdeName) {
        return explicitIdeName;
    }

    // Check specific variants first since they often inherit VS Code env vars
    
    // Antigravity sets its own markers
    if (process.env.ANTIGRAVITY_VERSION || process.env.GEMINI_API_KEY) {
        return 'Antigravity';
    }
    
    // Cursor sets trace dir and channel
    if (process.env.CURSOR_TRACE_DIR || process.env.CURSOR_CHANNEL) {
        return 'Cursor';
    }
    
    // Claude Code CLI
    if (process.env.CLAUDE_CODE || process.env.ANTHROPIC_API_KEY) {
        return 'Claude Code';
    }

    // Check generic VS Code markers last
    if (process.env.VSCODE_PID || process.env.VSCODE_CWD || process.env.TERM_PROGRAM === 'vscode') {
        return 'VS Code';
    }

    return 'Unknown IDE';
}
