import { LokiTransport } from './lokiTransport.js';

class Logger {
    private loki: LokiTransport | undefined;
    private static instance: Logger;

    private constructor() {
        const lokiUrl = process.env.LOKI_URL;
        if (lokiUrl) {
            this.loki = new LokiTransport({
                url: lokiUrl,
                service: 'mcp-server',
                environment: process.env.APP_ENV || 'development'
            });
            // Don't log to console here to avoid polluting stdio if it's strictly JSON-RPC
        }
    }

    public static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }

    public info(message: string) {
        // MCP uses stdio for communication. 
        // We probably shouldn't log INFO to stderr unless verbose. 
        // But we definitely send to Loki.
        // console.error(`[INFO] ${message}`);
        this.loki?.log('INFO', message);
    }

    public error(message: string, error?: unknown) {
        console.error(`[ERROR] ${message}`, error);
        
        let errorMsg = message;
        if (error instanceof Error) {
            errorMsg += ` Stack: ${error.stack}`;
        } else if (error) {
            errorMsg += ` Details: ${JSON.stringify(error)}`;
        }

        this.loki?.log('ERROR', errorMsg);
    }

    public warn(message: string) {
        console.error(`[WARN] ${message}`);
        this.loki?.log('WARN', message);
    }

    public dispose() {
        this.loki?.dispose();
    }
}

export const logger = Logger.getInstance();
