import { Emitter } from './events';
import { redact, redactValue } from './redaction';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: number;
  level: LogLevel;
  /** Server id the line belongs to, or undefined for McpLab-wide lines. */
  serverId?: string;
  /** Where the line came from: 'mcplab' | 'stderr' | 'server' (MCP logging notification). */
  source: 'mcplab' | 'stderr' | 'server';
  message: string;
  detail?: unknown;
}

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** In-memory ring buffer of log lines plus a live event stream. */
export class LogStore {
  private entries: LogEntry[] = [];
  private readonly changed = new Emitter<LogEntry>();
  readonly onDidLog = this.changed.on.bind(this.changed);

  constructor(
    private readonly capacity = 5000,
    /** Masking is on by default: logs get pasted into issues and chats. */
    private redactSecrets = true,
  ) {}

  setRedaction(enabled: boolean): void {
    this.redactSecrets = enabled;
  }

  append(rawEntry: LogEntry): void {
    const entry: LogEntry = this.redactSecrets
      ? {
          ...rawEntry,
          message: redact(rawEntry.message),
          detail: rawEntry.detail === undefined ? undefined : redactValue(rawEntry.detail),
        }
      : rawEntry;

    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
    this.changed.fire(entry);
  }

  log(
    level: LogLevel,
    message: string,
    options: { serverId?: string; source?: LogEntry['source']; detail?: unknown } = {},
  ): void {
    this.append({
      timestamp: Date.now(),
      level,
      message,
      serverId: options.serverId,
      source: options.source ?? 'mcplab',
      detail: options.detail,
    });
  }

  query(filter: { serverId?: string; minLevel?: LogLevel; search?: string } = {}): LogEntry[] {
    const min = filter.minLevel ? RANK[filter.minLevel] : 0;
    const needle = filter.search?.toLowerCase();
    return this.entries.filter((e) => {
      if (filter.serverId && e.serverId !== filter.serverId) return false;
      if (RANK[e.level] < min) return false;
      if (needle && !e.message.toLowerCase().includes(needle)) return false;
      return true;
    });
  }

  clear(serverId?: string): void {
    this.entries = serverId ? this.entries.filter((e) => e.serverId !== serverId) : [];
  }
}
