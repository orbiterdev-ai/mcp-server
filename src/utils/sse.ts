import { getAuthHeaders } from './auth.js';

/**
 * SSE Client for Approval Waiting
 * 
 * Opens a Server-Sent Events connection to the backend's SSE endpoint.
 * The backend holds the connection open and pushes events when:
 * - The approval status changes (decision event)
 * - 60s passes without decision (reminder event)
 * - 300s timeout (timeout event)
 * - Every 30s (heartbeat keepalive)
 * 
 * Includes exponential backoff retry (5s→30s, max 10 attempts, jitter)
 * for transient connection failures. Does NOT retry on terminal events
 * (timeout, closed, decision).
 */

export interface SSEDecision {
    status: 'approved' | 'rejected' | 'denied' | 'expired' | 'cancelled' | 'timeout';
    notes: string;
    timedOut: boolean;
    method: 'sse' | 'poll';
}

/** Retry configuration for SSE reconnection */
const SSE_RETRY_CONFIG = {
    /** Initial retry delay in ms */
    baseDelayMs: 5_000,
    /** Maximum retry delay in ms */
    maxDelayMs: 30_000,
    /** Maximum number of retry attempts */
    maxAttempts: 10,
    /** Jitter factor (0-1) - randomizes delay to prevent thundering herd */
    jitterFactor: 0.3,
} as const;

/**
 * Calculate retry delay with exponential backoff and jitter.
 * Formula: min(baseDelay * 2^attempt, maxDelay) ± jitter
 */
function calculateRetryDelay(attempt: number): number {
    const { baseDelayMs, maxDelayMs, jitterFactor } = SSE_RETRY_CONFIG;
    const exponentialDelay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
    const jitter = exponentialDelay * jitterFactor * (Math.random() * 2 - 1); // ±jitterFactor
    return Math.max(0, Math.round(exponentialDelay + jitter));
}

/**
 * Wait for an approval decision via SSE stream with automatic retry.
 * 
 * Retries on transient connection failures with exponential backoff.
 * Does NOT retry on terminal events (timeout, closed, decision).
 * 
 * @param serverUrl - Backend URL (e.g. https://api.orbiterdev.ai)
 * @param approvalId - UUID of the approval to wait for
 * @returns Decision result
 */
export async function sseWaitForDecision(
    serverUrl: string,
    approvalId: string,
    timeoutSeconds: number = 300
): Promise<SSEDecision> {
    let attempt = 0;
    const deadline = Date.now() + (Math.max(0.05, timeoutSeconds) * 1000);

    while (attempt < SSE_RETRY_CONFIG.maxAttempts && Date.now() < deadline) {
        try {
            const remainingMs = Math.max(50, deadline - Date.now());
            const result = await sseConnect(serverUrl, approvalId, remainingMs);
            return result; // Terminal result - don't retry
        } catch (err) {
            attempt++;

            // Check if this is a terminal error that shouldn't be retried
            if (err instanceof SSETerminalError) {
                throw err;
            }

            if (attempt >= SSE_RETRY_CONFIG.maxAttempts || Date.now() >= deadline) {
                process.stderr.write(
                    `[orbiter] ❌ SSE: All ${SSE_RETRY_CONFIG.maxAttempts} retry attempts exhausted for approval ${approvalId}\n`
                );
                throw err;
            }

            const delay = calculateRetryDelay(attempt - 1);
            process.stderr.write(
                `[orbiter] 🔄 SSE: Connection lost, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt}/${SSE_RETRY_CONFIG.maxAttempts})...\n`
            );

            await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
        }
    }

    return {
        status: 'timeout',
        notes: `No SSE decision received within ${timeoutSeconds}s`,
        timedOut: true,
        method: 'sse',
    };
}

/** Error class for terminal SSE errors that should NOT be retried */
class SSETerminalError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SSETerminalError';
    }
}

/** Promise-based sleep */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Single SSE connection attempt.
 * Resolves with a decision on terminal events (decision, timeout, closed).
 * Rejects on connection errors (retryable).
 */
function sseConnect(
    serverUrl: string,
    approvalId: string,
    timeoutMs: number
): Promise<SSEDecision> {
    const url = `${serverUrl}/api/v1/approvals/${approvalId}/sse`;
    const headers = getAuthHeaders();

    return new Promise<SSEDecision>((resolve, reject) => {
        const controller = new AbortController();

        const safetyTimeout = setTimeout(() => {
            controller.abort();
            resolve({
                status: 'timeout',
                notes: 'Client-side safety timeout',
                timedOut: true,
                method: 'sse',
            });
        }, timeoutMs);

        fetch(url, {
            headers: {
                ...headers,
                'Accept': 'text/event-stream',
            },
            signal: controller.signal,
        })
            .then(async (response) => {
                if (!response.ok) {
                    // 4xx errors are terminal (bad request, unauthorized)
                    if (response.status >= 400 && response.status < 500) {
                        throw new SSETerminalError(
                            `SSE connection failed with ${response.status} - not retryable`
                        );
                    }
                    throw new Error(`SSE connection failed: ${response.status}`);
                }

                if (!response.body) {
                    throw new Error('SSE response has no body');
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        // Stream ended unexpectedly - this is retryable
                        throw new Error('SSE stream ended unexpectedly');
                    }

                    buffer += decoder.decode(value, { stream: true });

                    // Parse SSE events from buffer
                    const events = parseSSEBuffer(buffer);
                    buffer = events.remaining;

                    for (const event of events.parsed) {
                        if (event.type === 'decision') {
                            const eventApprovalId = event.data.approval_id ?? event.data.id;
                            if (eventApprovalId !== undefined && String(eventApprovalId) !== String(approvalId)) {
                                // Ignore decision events bound to a different approval ID.
                                continue;
                            }
                            const normalizedStatus = typeof event.data.status === 'string'
                                ? event.data.status.trim().toLowerCase()
                                : '';
                            if (!normalizedStatus || normalizedStatus === 'pending') {
                                // Ignore non-terminal or incomplete decision payloads.
                                continue;
                            }
                            clearTimeout(safetyTimeout);
                            controller.abort();
                            const status = normalizedStatus as SSEDecision['status'];
                            resolve({
                                status,
                                notes: typeof event.data.notes === 'string' ? event.data.notes : '',
                                timedOut: false,
                                method: 'sse',
                            });
                            return;
                        }

                        if (event.type === 'timeout') {
                            clearTimeout(safetyTimeout);
                            controller.abort();
                            resolve({
                                status: 'timeout',
                                notes: event.data.message || 'Server timeout',
                                timedOut: true,
                                method: 'sse',
                            });
                            return;
                        }

                        if (event.type === 'closed') {
                            clearTimeout(safetyTimeout);
                            controller.abort();
                            resolve({
                                status: 'timeout',
                                notes: event.data.reason || 'Channel closed',
                                timedOut: true,
                                method: 'sse',
                            });
                            return;
                        }

                        if (event.type === 'reminder') {
                            // Log but continue waiting
                            process.stderr.write(
                                `[orbiter] ⏳ Reminder: ${event.data.message}\n`
                            );
                        }

                        // 'connected' and keepalive are silently consumed
                    }
                }
            })
            .catch((err) => {
                clearTimeout(safetyTimeout);
                if (err.name === 'AbortError') {
                    // Already resolved via safety timeout - don't reject
                    return;
                }
                reject(err);
            });
    });
}

/**
 * Parse SSE events from a text buffer.
 * Returns parsed events and any remaining unparsed text.
 */
function parseSSEBuffer(buffer: string): {
    parsed: Array<{ type: string; data: Record<string, string> }>;
    remaining: string;
} {
    const parsed: Array<{ type: string; data: Record<string, string> }> = [];
    const blocks = buffer.split('\n\n');

    // Last block may be incomplete
    const remaining = blocks.pop() || '';

    for (const block of blocks) {
        if (!block.trim()) continue;

        let eventType = 'message';
        let dataLines: string[] = [];

        for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) {
                eventType = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
                dataLines.push(line.slice(6));
            }
            // Comments (starting with ':') are silently ignored (keepalive)
        }

        if (dataLines.length > 0) {
            try {
                const data = JSON.parse(dataLines.join('\n'));
                parsed.push({ type: eventType, data });
            } catch {
                // Non-JSON data, wrap as message
                parsed.push({
                    type: eventType,
                    data: { message: dataLines.join('\n') },
                });
            }
        }
    }

    return { parsed, remaining };
}
