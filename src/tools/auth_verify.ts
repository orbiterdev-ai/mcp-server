import { z } from 'zod';
import { saveCredentials, OrbiterCredentials } from '../auth/credentials.js';

export const authVerifyTool = {
    name: "orbiter_auth_verify",
    description: `Check if the user has completed pairing on their Orbiter Dev mobile app (iOS and Android). Call this after orbiter_auth has returned a pairing code and the user confirms they have entered it.

Input: the device_code string that orbiter_auth returned.

Behavior:
- Polls the backend for up to 60 seconds to check if the user entered the code.
- Returns "paired" on success, "pending" if still waiting, or an error if expired/denied.
- If "pending", ask the user if they've entered the code yet, then call this tool again.`,
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
                description: "The device_code returned by orbiter_auth"
            }
        },
        required: ["device_code"]
    }
};

export async function handleAuthVerify(args: unknown): Promise<{ content: Array<{ type: string; text: string }> }> {
    const inputSchema = z.object({
        device_code: z.string()
    });
    const input = inputSchema.parse(args);

    const backendUrl = process.env.ORBITER_SERVER_URL || 'https://api.orbiterdev.ai';
    const deviceCode = input.device_code;

    const maxWaitMs = 60_000; // 60 seconds max per call
    const intervalMs = 5_000; // 5 second intervals
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
                            text: 'The pairing code has expired. Please call orbiter_auth again to get a new code.'
                        }]
                    };
                }
                if (errBody.includes('access_denied')) {
                    return {
                        content: [{
                            type: 'text',
                            text: 'The pairing request was denied by the user.'
                        }]
                    };
                }
                // Server error - wait and retry
                await sleep(intervalMs);
                continue;
            }

            const jsonResponse: any = await response.json();
            const data = jsonResponse.data || jsonResponse;
            const status = data?.status || (data?.api_key ? 'authorized' : 'authorization_pending');

            if (status === 'authorized') {
                if (data.api_key && data.user_id) {
                    // First-time authorization - save credentials
                    const newCreds: OrbiterCredentials = {
                        api_key: data.api_key,
                        user_id: data.user_id,
                        paired_at: new Date().toISOString(),
                        backend_url: backendUrl
                    };
                    saveCredentials(newCreds);

                    return {
                        content: [{
                            type: 'text',
                            text: 'Paired successfully! ✅ Your IDE is now connected to Orbiter Dev.'
                        }]
                    };
                } else {
                    // Re-poll of already-issued code (api_key not returned again)
                    return {
                        content: [{
                            type: 'text',
                            text: 'Paired successfully! ✅ (Credentials were already saved from a previous pairing.)'
                        }]
                    };
                }
            }

            if (status === 'awaiting_confirmation') {
                // Code was claimed, waiting for mobile user to tap "Allow"
                // Keep polling within this 60s window
            }
        } catch (err: any) {
            if (err.message && (err.message.includes('expired') || err.message.includes('denied'))) {
                return {
                    content: [{
                        type: 'text',
                        text: `Pairing failed: ${err.message}. Please call orbiter_auth to get a new code.`
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
            text: 'Still waiting for the pairing code to be entered on the phone. The code is still valid. Ask the user if they have entered the code in the Orbiter Dev app, then call orbiter_auth_verify again with the same device_code.'
        }]
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
