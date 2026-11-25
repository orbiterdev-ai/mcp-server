import { getAuthHeaders } from './auth.js';

/**
 * Orbiter Telemetry - OpenTelemetry-Compatible Agent Event Capture
 *
 * Captures AI agent tool calls, approvals, file operations, and session metrics.
 * Data is exported in an OTEL-compatible JSON format to the Orbiter backend,
 * which can forward to Grafana/Loki/Datadog/Splunk.
 *
 * Design principles:
 * - Lightweight: no heavy OTEL SDK, just structured JSON
 * - Non-blocking: events are batched and flushed asynchronously
 * - Privacy-safe: no source code content, only metadata
 */

// ── Types ──

export interface TelemetrySpan {
    trace_id: string;
    span_id: string;
    name: string;
    kind: 'tool_call' | 'approval' | 'file_op' | 'session' | 'error' | 'command';
    start_time: string; // ISO 8601
    end_time?: string;
    duration_ms?: number;
    status: 'ok' | 'error' | 'timeout' | 'pending';
    attributes: Record<string, string | number | boolean>;
    events?: TelemetryEvent[];
}

export interface TelemetryEvent {
    name: string;
    timestamp: string;
    attributes: Record<string, string | number | boolean>;
}

export interface TelemetryBatch {
    resource: {
        service_name: string;
        service_version: string;
        telemetry_sdk: string;
        ide: string;
        machine_id: string;
        session_id: string;
    };
    spans: TelemetrySpan[];
}

// ── Span Context ──

export interface SpanContext {
    trace_id: string;
    span_id: string;
    start: number; // Date.now()
    name: string;
    kind: TelemetrySpan['kind'];
    attributes: Record<string, string | number | boolean>;
    events: TelemetryEvent[];
}

// ── Telemetry Client ──

const MAX_BATCH_SIZE = 50;
const FLUSH_INTERVAL_MS = 10_000; // 10 seconds

export class OrbiterTelemetry {
    private spans: TelemetrySpan[] = [];
    private serverUrl: string;
    private sessionId: string;
    private ide: string;
    private machineId: string;
    private flushTimer: ReturnType<typeof setInterval> | null = null;

    constructor(opts: {
        serverUrl?: string;
        sessionId?: string;
        ide?: string;
        machineId?: string;
    } = {}) {
        this.serverUrl = opts.serverUrl || process.env.ORBITER_SERVER_URL || 'https://api.orbiterdev.ai';
        this.sessionId = opts.sessionId || process.env.ORBITER_SESSION_ID || generateId();
        this.ide = opts.ide || detectIDE();
        this.machineId = opts.machineId || process.env.HOSTNAME || 'unknown';

        // Auto-flush periodically
        this.flushTimer = setInterval(() => this.flush().catch(() => {}), FLUSH_INTERVAL_MS);
    }

    /**
     * Start a new telemetry span (e.g., for a tool call).
     */
    startSpan(
        name: string,
        kind: TelemetrySpan['kind'],
        attributes: Record<string, string | number | boolean> = {}
    ): SpanContext {
        return {
            trace_id: generateId(),
            span_id: generateId(),
            start: Date.now(),
            name,
            kind,
            attributes,
            events: [],
        };
    }

    /**
     * Add an event to an open span.
     */
    addEvent(
        ctx: SpanContext,
        eventName: string,
        attributes: Record<string, string | number | boolean> = {}
    ): void {
        ctx.events.push({
            name: eventName,
            timestamp: new Date().toISOString(),
            attributes,
        });
    }

    /**
     * End a span and queue it for export.
     */
    endSpan(ctx: SpanContext, status: TelemetrySpan['status'] = 'ok'): void {
        const endTime = Date.now();
        const span: TelemetrySpan = {
            trace_id: ctx.trace_id,
            span_id: ctx.span_id,
            name: ctx.name,
            kind: ctx.kind,
            start_time: new Date(ctx.start).toISOString(),
            end_time: new Date(endTime).toISOString(),
            duration_ms: endTime - ctx.start,
            status,
            attributes: ctx.attributes,
            events: ctx.events.length > 0 ? ctx.events : undefined,
        };

        this.spans.push(span);

        // Auto-flush if batch is large
        if (this.spans.length >= MAX_BATCH_SIZE) {
            this.flush().catch(() => {});
        }
    }

    /**
     * Record a self-contained event (start + end in one call).
     */
    record(
        name: string,
        kind: TelemetrySpan['kind'],
        attributes: Record<string, string | number | boolean> = {},
        durationMs: number = 0
    ): void {
        const now = Date.now();
        this.spans.push({
            trace_id: generateId(),
            span_id: generateId(),
            name,
            kind,
            start_time: new Date(now - durationMs).toISOString(),
            end_time: new Date(now).toISOString(),
            duration_ms: durationMs,
            status: 'ok',
            attributes,
        });
    }

    /**
     * Flush all queued spans to the backend.
     */
    async flush(): Promise<void> {
        if (this.spans.length === 0) return;

        const batch: TelemetryBatch = {
            resource: {
                service_name: 'orbiter-mcp',
                service_version: '0.2.0',
                telemetry_sdk: 'orbiter-telemetry/1.0',
                ide: this.ide,
                machine_id: this.machineId,
                session_id: this.sessionId,
            },
            spans: [...this.spans],
        };

        // Clear the buffer
        this.spans = [];

        try {
            await fetch(`${this.serverUrl}/api/v1/telemetry`, {
                method: 'POST',
                headers: getAuthHeaders(),
                body: JSON.stringify(batch),
            });
        } catch {
            // Telemetry is best-effort - never block the agent
            process.stderr.write(`[orbiter-telemetry] Failed to flush ${batch.spans.length} spans\n`);
            // Re-add failed spans (up to limit) for retry
            this.spans.push(...batch.spans.slice(0, MAX_BATCH_SIZE - this.spans.length));
        }
    }

    /**
     * Shutdown: flush remaining spans and stop timer.
     */
    async shutdown(): Promise<void> {
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
        await this.flush();
    }
}

// ── Singleton ──

let instance: OrbiterTelemetry | null = null;

export function getTelemetry(): OrbiterTelemetry {
    if (!instance) {
        instance = new OrbiterTelemetry();
    }
    return instance;
}

// ── Helpers ──

function generateId(): string {
    return [...Array(16)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
}

function detectIDE(): string {
    if (process.env.ANTIGRAVITY_SESSION || process.env.WINDSURF_SESSION) return 'antigravity';
    if (process.env.CURSOR_TRACE_ID || process.env.CURSOR_SESSION_ID) return 'cursor';
    if (process.env.CLAUDE_CODE || process.env.MCP_CLIENT === 'claude') return 'claude_code';
    if (process.env.VSCODE_PID) return 'vscode';
    return 'unknown';
}
