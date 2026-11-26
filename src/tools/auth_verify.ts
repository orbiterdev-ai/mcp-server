import { z } from 'zod';
import { saveCredentials, OrbiterCredentials } from '../auth/credentials.js';

export const authVerifyTool = {
    name: "orbiter_auth_verify",
    description: `Poll for mobile confirmation of a pairing code claimed via \`orbiter_auth\` and persist local API credentials once approved on the Orbiter Dev mobile app (iOS and Android).

State mutation (\`readOnlyHint: false\`): When the backend returns an authorized pairing, this tool writes the issued API key, user ID, pairing timestamp, and backend URL locally to \`~/.orbiter/credentials\` (or the override path in \`ORBITER_CREDENTIAL_PATH\` / \`ORBITER_CREDENTIAL_PROFILE\`) with restrictive 0600 file permissions.

Polling & return payload: Polls every 5 seconds for up to 60 seconds per call (pairing codes remain valid for 5 minutes total) and returns JSON with \`success\` (boolean), \`status\` (\`"paired"\`, \`"pending"\`, \`"expired"\`, or \`"denied"\`), \`message\`, and optional \`credentials_saved\` / \`error\` / \`recovery\` fields:
- \`"paired"\`: Confirmation succeeded and local credentials are persisted (or already saved on re-poll); all other Orbiter tools are now authenticated.
- \`"pending"\`: Confirmation not yet tapped within the 60s poll window; ask the user to tap "Allow" in the Orbiter Dev app and call \`orbiter_auth_verify\` again with the same \`device_code\`.
- \`"expired"\` or \`"denied"\`: Pairing cannot complete with this \`device_code\`. Recovery: ask the user for a new pairing code from Settings -> Pair IDE and re-run \`orbiter_auth\` to start a fresh pairing flow.`,
    annotations: {
        title: "Verify Mobile Pairing",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
    },
    inputSchema: {
        type: "object",
        properties: {
            device_code: {
                type: "string",
                format: "uuid",
                minLength: 1,
                description: "The device_code UUID returned by orbiter_auth after claiming the user's mobile pairing code (required)."
            }
        },
        required: ["device_code"]
    }
};

export interface AuthVerifyOptions {
    backendUrl?: string;
    maxWaitMs?: number;
    intervalMs?: number;
}

export async function handleAuthVerify(
    args: unknown,
    options: AuthVerifyOptions = {}
): Promise<{ content: Array<{ type: string; text: string }> }> {
    const inputSchema = z.object({
        device_code: z.string().min(1)
    });
    const input = inputSchema.parse(args);

    const backendUrl = (
        options.backendUrl ||
        process.env.ORBITER_API_URL ||
        process.env.ORBITER_SERVER_URL ||
        'https://api.orbiterdev.ai'
    ).replace(/\/+$/, '');
    const deviceCode = input.device_code.trim();

    const maxWaitMs = options.maxWaitMs ?? 60_000; // 60 seconds max per call
    const intervalMs = options.intervalMs ?? 5_000; // 5 second intervals
    const start = Date.now();

    while (Date.now() - start < maxWaitMs) {
        try {
            const response = await fetch(
                `${backendUrl}/api/v1/auth/device/poll?device_code=${encodeURIComponent(deviceCode)}`
            );

            if (!response.ok) {
                const errBody = await response.text();
                // Check for expired/denied errors
                if (errBody.includes('expired_token')) {
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                status: 'expired',
                                error: 'expired_token',
                                message: 'The pairing code has expired.',
                                recovery: 'Ask the user for a fresh pairing code from Settings -> Pair IDE in the Orbiter Dev mobile app and re-run orbiter_auth.',
                            }, null, 2)
                        }]
                    };
                }
                if (errBody.includes('access_denied')) {
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                status: 'denied',
                                error: 'access_denied',
                                message: 'The pairing request was denied by the user on mobile.',
                                recovery: 'Confirm the user wants to connect this workspace, then generate a new pairing code in Settings -> Pair IDE and re-run orbiter_auth.',
                            }, null, 2)
                        }]
                    };
                }
                // Server error - wait and retry
                await sleep(intervalMs);
                continue;
            }

            const jsonResponse = await response.json() as Record<string, unknown>;
            const data = (jsonResponse.data && typeof jsonResponse.data === 'object'
                ? jsonResponse.data
                : jsonResponse) as Record<string, unknown>;
            const apiKey = typeof data.api_key === 'string' ? data.api_key : undefined;
            const userId = typeof data.user_id === 'string' ? data.user_id : undefined;
            const status = typeof data.status === 'string'
                ? data.status
                : (apiKey ? 'authorized' : 'authorization_pending');

            if (status === 'authorized') {
                if (apiKey && userId) {
                    // First-time authorization - persist credentials locally (0600)
                    const newCreds: OrbiterCredentials = {
                        api_key: apiKey,
                        user_id: userId,
                        paired_at: new Date().toISOString(),
                        backend_url: backendUrl
                    };
                    saveCredentials(newCreds);

                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success: true,
                                status: 'paired',
                                credentials_saved: true,
                                message: 'Paired successfully. Local API credentials saved to ~/.orbiter/credentials and workspace is now connected to Orbiter Dev.',
                            }, null, 2)
                        }]
                    };
                } else {
                    // Re-poll of already-issued code (api_key not returned again)
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success: true,
                                status: 'paired',
                                credentials_saved: false,
                                message: 'Paired successfully. Credentials were already saved from a previous verification.',
                            }, null, 2)
                        }]
                    };
                }
            }

            if (status === 'awaiting_confirmation') {
                // Code was claimed, waiting for mobile user to tap "Allow"
                // Keep polling within this 60s window
            }
        } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            if (errorMessage.includes('expired') || errorMessage.includes('denied')) {
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: false,
                            status: errorMessage.includes('expired') ? 'expired' : 'denied',
                            error: errorMessage,
                            message: `Pairing failed: ${errorMessage}.`,
                            recovery: 'Generate a fresh pairing code in Settings -> Pair IDE and re-run orbiter_auth.',
                        }, null, 2)
                    }]
                };
            }
            // Network error - wait and retry
        }

        await sleep(intervalMs);
    }

    // Timed out after 60s but code may still be valid (has 5min lifetime)
    return {
        content: [{
            type: 'text',
            text: JSON.stringify({
                success: false,
                status: 'pending',
                message: 'Still waiting for confirmation on the phone. Ask the user to tap "Allow" in the Orbiter Dev app, then call orbiter_auth_verify again with the same device_code.',
            }, null, 2)
        }]
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
