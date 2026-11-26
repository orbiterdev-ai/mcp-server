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
            const approval = data?.data;

            if (!approval || typeof approval !== 'object') {
                lastError = 'No approval data in response';
                await sleep(intervalMs);
                continue;
            }

            // Bind polled decision strictly to the tracked approvalId when ID is returned.
            const returnedId = extractPollString(approval.id);
            if (returnedId && returnedId !== String(approvalId)) {
                lastError = `Approval ID mismatch (expected ${approvalId}, got ${returnedId})`;
                await sleep(intervalMs);
                continue;
            }

            const rawStatus = extractPollString(approval.status);
            const status = rawStatus ? rawStatus.toLowerCase() : '';

            // If status is terminal (non-pending), return the server's authoritative decision.
            if (status && status !== 'pending') {
                return {
                    status,
                    notes: extractPollString(approval.response_notes) || '',
                    timedOut: false,
                };
            }

            // Still pending or incomplete - wait and retry
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

function extractPollString(value: unknown): string | undefined {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : undefined;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return String(value);
    }
    if (value && typeof value === 'object' && 'String' in value) {
        const nullable = value as { String?: unknown; Valid?: unknown };
        if (nullable.Valid === false) return undefined;
        if (typeof nullable.String === 'string') {
            const trimmed = nullable.String.trim();
            return trimmed.length > 0 ? trimmed : undefined;
        }
    }
    return undefined;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
