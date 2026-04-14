export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
}

class Logger {
  private logs: LogEntry[] = [];

  log(level: LogLevel, message: string): void {
    const now = new Date();
    const timestamp = [
      now.getHours().toString().padStart(2, '0'),
      now.getMinutes().toString().padStart(2, '0'),
      now.getSeconds().toString().padStart(2, '0'),
    ].join(':') + '.' + now.getMilliseconds().toString().padStart(3, '0');

    this.logs.push({ timestamp, level, message });
  }

  info(message: string): void {
    this.log('info', message);
  }

  warn(message: string): void {
    this.log('warn', message);
  }

  error(message: string): void {
    this.log('error', message);
  }

  toClipboardText(): string {
    if (this.logs.length === 0) return '(no logs)';

    const levelTag: Record<LogLevel, string> = {
      info: 'INFO ',
      warn: 'WARN ',
      error: 'ERROR',
    };

    return this.logs
      .map((e) => `[${e.timestamp}] [${levelTag[e.level]}] ${e.message}`)
      .join('\n');
  }

  clear(): void {
    this.logs = [];
  }
}

export const logger = new Logger();
