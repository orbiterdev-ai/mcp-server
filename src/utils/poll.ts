import { getAuthHeaders } from './auth.js';

/**
 * Poll for an approval decision.
 * 
 * After submitting an approval request, this polls the backend
 * until the status changes from "pending" to "approved" or "rejected".
 * 
 * @param serverUrl - Backend URL (e.g. https://api.orbiterdev.ai)
 * @param approvalId - UUID of the approval to poll
 * @param timeoutSeconds - Max seconds to wait (default 300, matching the SSE path so the
 *   approval window does not silently shrink to 2 minutes when SSE fails and the hook
 *   falls back to polling - the user-facing contract is "5 minutes" on every transport)
 * @param intervalMs - Poll interval in ms (default 3000)
 * @returns The final approval status and details
 */
export async function pollForDecision(
    serverUrl: string,
    approvalId: string,
    timeoutSeconds: number = 300,
    intervalMs: number = 3000
): Promise<{ status: string; notes: string; timedOut: boolean }> {
    const deadline = Date.now() + (timeoutSeconds * 1000);
    let lastError = '';

    while (Date.now() < deadline) {
        try {
            const response = await fetch(`${serverUrl}/api/v1/approvals/${approvalId}`, {
                method: 'GET',
                headers: getAuthHeaders(),
            });

            if (!response.ok) {
                lastError = `Server responded with ${response.status}`;
                // Don't throw - keep polling. Server might be temporarily busy.
                await sleep(intervalMs);
                continue;
            }

            const data: any = await response.json();
            const approval = data.data;

            if (!approval) {
                lastError = 'No approval data in response';
                await sleep(intervalMs);
                continue;
            }

            const status = approval.status?.String || approval.status;

            // If status is no longer pending, we have a decision
            if (status && status !== 'pending') {
                return {
                    status,
                    notes: approval.response_notes?.String || approval.response_notes || '',
                    timedOut: false,
                };
            }

            // Still pending - wait and retry
            await sleep(intervalMs);
        } catch (error: any) {
            lastError = error.message;
            // Network error - wait and retry
            await sleep(intervalMs);
        }
    }

    // Timed out
    return {
        status: 'timeout',
        notes: `No decision received within ${timeoutSeconds}s. Last error: ${lastError}`,
        timedOut: true,
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
