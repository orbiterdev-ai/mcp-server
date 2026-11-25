export interface LokiConfig {
    url: string;
    service: string;
    environment: string;
    batchSize?: number;
    pushIntervalMs?: number;
}

interface LokiStream {
    stream: Record<string, string>;
    values: [string, string][];
}

interface LokiPushRequest {
    streams: LokiStream[];
}

export class LokiTransport {
    private buffer: { timestamp: number; level: string; message: string }[] = [];
    private timer: NodeJS.Timeout | undefined;
    private config: LokiConfig;

    constructor(config: LokiConfig) {
        this.config = {
            batchSize: 100,
            pushIntervalMs: 10000,
            ...config
        };

        this.startTimer();
    }

    public log(level: string, message: string) {
        this.buffer.push({
            timestamp: Date.now(),
            level,
            message
        });

        if (this.buffer.length >= (this.config.batchSize || 100)) {
            this.flush();
        }
    }

    public async flush() {
        if (this.buffer.length === 0) return;

        const entries = [...this.buffer];
        this.buffer = [];

        try {
            await this.send(entries);
        } catch (error) {
            console.error('Failed to send logs to Loki:', error);
        }
    }

    private async send(entries: { timestamp: number; level: string; message: string }[]) {
        if (!this.config.url) return;

        // Group by level
        const streams: Record<string, [string, string][]> = {};

        for (const entry of entries) {
            const ns = (entry.timestamp * 1000000).toString(); // Nanoseconds
            if (!streams[entry.level]) {
                streams[entry.level] = [];
            }
            streams[entry.level].push([ns, entry.message]);
        }

        const pushRequest: LokiPushRequest = {
            streams: Object.entries(streams).map(([level, values]) => ({
                stream: {
                    service: this.config.service,
                    environment: this.config.environment,
                    level: level.toLowerCase()
                },
                values
            }))
        };

        try {
            const response = await fetch(this.config.url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(pushRequest)
            });

            if (!response.ok) {
                const text = await response.text();
                throw new Error(`Loki returned ${response.status}: ${text}`);
            }
        } catch (err) {
            throw err;
        }
    }

    private startTimer() {
        if (this.timer) clearInterval(this.timer);
        this.timer = setInterval(() => {
            this.flush();
        }, this.config.pushIntervalMs);
    }

    public dispose() {
        if (this.timer) clearInterval(this.timer);
        this.flush();
    }
}
