import { z } from 'zod';
import { loadCredentials, validateCredentials, getCredentialPath } from '../auth/credentials.js';
import * as fs from 'fs';
import * as os from 'os';

export const authTool = {
    name: "orbiter_auth",
    description: `Pair this workspace with your Orbiter Dev mobile app (iOS and Android).

If the user provides a pairing code (e.g. ORBIT-K7N3), pass it as the "code" parameter. The code is generated on the Orbiter Dev mobile app under Settings -> Pair IDE.

If no code is provided, ask the user to open the Orbiter Dev app on their phone, go to Settings -> Pair IDE, and read out the code shown on screen.

After claiming the code, call orbiter_auth_verify with the device_code from this response to complete pairing.

Call this when you see authentication errors from other Orbiter tools.`,
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
                description: "The pairing code from the Orbiter Dev mobile app (e.g. ORBIT-K7N3)"
            }
        },
        required: ["code"]
    }
};

export async function handleAuth(args: unknown): Promise<{ content: Array<{ type: string; text: string }> }> {
    const inputSchema = z.object({
        code: z.string().optional()
    });
    const input = inputSchema.parse(args);

    const backendUrl = process.env.ORBITER_SERVER_URL || 'https://api.orbiterdev.ai';

    // 1. Check if already authenticated via env var
    const envToken = process.env.ORBITER_TOKEN;
    if (envToken) {
        return {
            content: [{
                type: 'text',
                text: "Already paired! ✅ (Using ORBITER_TOKEN environment variable)"
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
                    text: "Already paired! ✅"
                }]
            };
        } else {
            // Remove invalid creds
            try {
                if (fs.existsSync(getCredentialPath())) {
                   fs.unlinkSync(getCredentialPath());
                }
            } catch(e) {}
        }
    }

    // If no code provided, ask the user to get one from their phone
    if (!input.code) {
        return {
            content: [{
                type: 'text',
                text: [
                    'To pair your IDE, please:',
                    '1. Open the Orbiter Dev app on your phone',
                    '2. Go to Settings → Pair IDE',
                    '3. A pairing code (like ORBIT-K7N3) will be shown',
                    '4. Tell me the code and I will connect your IDE',
                    '',
                    'Then call this tool again with the code parameter.'
                ].join('\n')
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
            const errJson: any = await claimResponse.json().catch(() => ({}));
            const errMsg = errJson?.error || 'Invalid or expired pairing code';
            throw new Error(typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg));
        }

        const jsonResponse: any = await claimResponse.json();
        const data = jsonResponse.data || jsonResponse;
        const device_code = data.device_code;

        return {
            content: [{
                type: 'text',
                text: [
                    `Pairing code ${code} claimed successfully! ✅`,
                    ``,
                    `A confirmation request has been sent to the user's phone.`,
                    `The user needs to open Orbiter Dev and tap "Allow" to confirm the pairing.`,
                    ``,
                    `Call orbiter_auth_verify with device_code: "${device_code}" to check if the user has confirmed.`
                ].join('\n')
            }]
        };

    } catch (err: any) {
        return {
            content: [{
                type: 'text',
                text: `Pairing failed: ${err.message}`
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
