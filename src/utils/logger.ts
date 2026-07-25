/**
 * Structured logging utility for the Monarch MCP server.
 */

export enum LogLevel {
  ERROR = 'ERROR',
  WARN = 'WARN',
  INFO = 'INFO',
  DEBUG = 'DEBUG',
  SECURITY = 'SECURITY',
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  metadata?: Record<string, unknown>;
  error?: string;
}

class Logger {
  private isProduction: boolean;

  constructor() {
    this.isProduction = process.env.NODE_ENV === 'production';
  }

  private formatLog(level: LogLevel, message: string, metadata?: Record<string, unknown>, error?: Error): string {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      metadata,
      error: error?.message,
    };
    return JSON.stringify(entry);
  }

  error(message: string, metadata?: Record<string, unknown>, error?: Error): void {
    console.error(this.formatLog(LogLevel.ERROR, message, metadata, error));
  }
  warn(message: string, metadata?: Record<string, unknown>): void {
    console.error(this.formatLog(LogLevel.WARN, message, metadata));
  }
  info(message: string, metadata?: Record<string, unknown>): void {
    console.error(this.formatLog(LogLevel.INFO, message, metadata));
  }
  debug(message: string, metadata?: Record<string, unknown>): void {
    if (!this.isProduction) {
      console.error(this.formatLog(LogLevel.DEBUG, message, metadata));
    }
  }
  security(event: string, metadata?: Record<string, unknown>): void {
    console.error(this.formatLog(LogLevel.SECURITY, event, metadata));
  }
  authAttempt(success: boolean, ip?: string, sessionId?: string): void {
    this.security('auth_attempt', { success, ip, sessionId });
  }
  authFailure(reason: string, ip?: string): void {
    this.security('auth_failure', { reason, ip });
  }
  apiRequest(method: string, path: string, statusCode?: number, duration?: number): void {
    this.info('api_request', { method, path, statusCode, duration });
  }
  rateLimitExceeded(ip?: string, path?: string): void {
    this.security('rate_limit_exceeded', { ip, path });
  }
}

export const logger = new Logger();
