import { loadCredentials } from '../auth/credentials.js';

/**
 * Get standard headers for authenticated API requests.
 * Includes Authorization Bearer token from ORBITER_TOKEN env var.
 * Adds X-Orbiter-Trace-Id for cross-layer correlation.
 */
export function getAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Orbiter-Trace-Id': generateTraceId(),
    };

    // 1. Check ORBITER_TOKEN env var priority
    const token = process.env.ORBITER_TOKEN;
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
        return headers;
    }

    // 2. Check localized credentials fallback priority
    const creds = loadCredentials();
    if (creds && creds.api_key) {
        headers['Authorization'] = `Bearer ${creds.api_key}`;
    }

    return headers;
}

/**
 * Get auth headers with a specific trace ID (for correlating related calls).
 */
export function getAuthHeadersWithTrace(traceId: string): Record<string, string> {
    const headers = getAuthHeaders();
    headers['X-Orbiter-Trace-Id'] = traceId;
    return headers;
}

/**
 * Generate a 32-char hex trace ID (compatible with OTEL trace_id format).
 */
function generateTraceId(): string {
    return [...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
}
