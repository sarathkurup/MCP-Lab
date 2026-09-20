import { Emitter } from './events';

export type InvocationKind = 'tool' | 'resource' | 'prompt';

export interface HistoryEntry {
  id: string;
  timestamp: number;
  serverId: string;
  serverName: string;
  kind: InvocationKind;
  /** Tool name, resource URI or prompt name. */
  name: string;
  input: unknown;
  output?: unknown;
  error?: { code?: number; message: string; data?: unknown };
  durationMs: number;
  /** Environment the call ran against, once Phase 12 is in play. */
  environment?: string;
  /** True when the server replied with `isError`, which is not a transport failure. */
  toolError?: boolean;
}

/** Storage is injected so core stays free of VS Code's memento API. */
export interface HistoryPersistence {
  load(): HistoryEntry[];
  save(entries: HistoryEntry[]): void;
}

export class HistoryStore {
  private entries: HistoryEntry[] = [];
  private readonly changed = new Emitter<void>();
  readonly onDidChange = this.changed.on.bind(this.changed);

  constructor(
    private readonly persistence?: HistoryPersistence,
    private readonly capacity = 500,
  ) {
    if (persistence) {
      this.entries = persistence.load().slice(-capacity);
    }
  }

  add(entry: HistoryEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
    this.persistence?.save(this.entries);
    this.changed.fire();
  }

  /** Newest first, optionally narrowed to one server. */
  list(filter: { serverId?: string; kind?: InvocationKind; search?: string } = {}): HistoryEntry[] {
    const needle = filter.search?.toLowerCase();
    return this.entries
      .filter((e) => {
        if (filter.serverId && e.serverId !== filter.serverId) {
          return false;
        }
        if (filter.kind && e.kind !== filter.kind) {
          return false;
        }
        if (needle && !e.name.toLowerCase().includes(needle)) {
          return false;
        }
        return true;
      })
      .slice()
      .reverse();
  }

  get(id: string): HistoryEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  clear(serverId?: string): void {
    this.entries = serverId ? this.entries.filter((e) => e.serverId !== serverId) : [];
    this.persistence?.save(this.entries);
    this.changed.fire();
  }

  /** Call counts, failure rates and latency percentiles for the analytics view. */
  stats(serverId?: string): AnalyticsSummary {
    const scoped = serverId ? this.entries.filter((e) => e.serverId === serverId) : this.entries;
    const durations = scoped.map((e) => e.durationMs).sort((a, b) => a - b);
    const failures = scoped.filter((e) => e.error || e.toolError);

    const byName = new Map<string, { calls: number; failures: number; totalMs: number }>();
    for (const entry of scoped) {
      const key = `${entry.kind}:${entry.name}`;
      const bucket = byName.get(key) ?? { calls: 0, failures: 0, totalMs: 0 };
      bucket.calls++;
      bucket.totalMs += entry.durationMs;
      if (entry.error || entry.toolError) {
        bucket.failures++;
      }
      byName.set(key, bucket);
    }

    return {
      total: scoped.length,
      succeeded: scoped.length - failures.length,
      failed: failures.length,
      averageMs: durations.length ? Math.round(mean(durations)) : 0,
      p95Ms: percentile(durations, 0.95),
      p50Ms: percentile(durations, 0.5),
      byTarget: [...byName.entries()]
        .map(([key, bucket]) => ({
          name: key,
          calls: bucket.calls,
          failures: bucket.failures,
          failureRate: bucket.calls ? bucket.failures / bucket.calls : 0,
          averageMs: Math.round(bucket.totalMs / bucket.calls),
        }))
        .sort((a, b) => b.calls - a.calls),
    };
  }
}

export interface AnalyticsSummary {
  total: number;
  succeeded: number;
  failed: number;
  averageMs: number;
  p50Ms: number;
  p95Ms: number;
  byTarget: Array<{
    name: string;
    calls: number;
    failures: number;
    failureRate: number;
    averageMs: number;
  }>;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

let counter = 0;
export function newInvocationId(): string {
  counter = (counter + 1) % 100000;
  return `${Date.now().toString(36)}-${counter.toString(36)}`;
}
