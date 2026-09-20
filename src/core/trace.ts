import { Emitter } from './events';
import type { JsonRpcMessage } from './protocol';

export type TraceDirection = 'client->server' | 'server->client';

export interface TraceEntry {
  seq: number;
  timestamp: number;
  serverId: string;
  direction: TraceDirection;
  kind: 'request' | 'response' | 'notification' | 'error';
  method?: string;
  id?: string | number | null;
  message: JsonRpcMessage;
  /** Round-trip time in ms, set on the response entry when the request is matched. */
  durationMs?: number;
}

/**
 * Raw JSON-RPC frames in both directions. This is the substrate the protocol
 * debugger, the history view and the analytics view all read from, which is why
 * transports report frames here rather than the client synthesising them.
 */
export class TraceStore {
  private entries: TraceEntry[] = [];
  private seq = 0;
  private readonly pending = new Map<string, number>();
  private readonly changed = new Emitter<TraceEntry>();
  readonly onDidTrace = this.changed.on.bind(this.changed);

  constructor(private capacity = 2000) {}

  setCapacity(capacity: number): void {
    this.capacity = Math.max(100, capacity);
  }

  record(serverId: string, direction: TraceDirection, message: JsonRpcMessage): TraceEntry {
    const kind = classify(message);
    const id = 'id' in message ? (message.id ?? null) : undefined;
    const entry: TraceEntry = {
      seq: ++this.seq,
      timestamp: Date.now(),
      serverId,
      direction,
      kind,
      method: 'method' in message ? message.method : undefined,
      id,
      message,
    };

    const key = id === undefined || id === null ? undefined : `${serverId}:${id}`;
    if (key && kind === 'request') {
      this.pending.set(key, entry.timestamp);
    } else if (key && (kind === 'response' || kind === 'error')) {
      const started = this.pending.get(key);
      if (started !== undefined) {
        entry.durationMs = entry.timestamp - started;
        this.pending.delete(key);
      }
    }

    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
    this.changed.fire(entry);
    return entry;
  }

  list(serverId?: string): TraceEntry[] {
    return serverId ? this.entries.filter((e) => e.serverId === serverId) : [...this.entries];
  }

  clear(serverId?: string): void {
    this.entries = serverId ? this.entries.filter((e) => e.serverId !== serverId) : [];
    if (!serverId) this.pending.clear();
  }
}

function classify(message: JsonRpcMessage): TraceEntry['kind'] {
  if ('error' in message) return 'error';
  if ('result' in message) return 'response';
  if ('id' in message && message.id !== undefined && message.id !== null) return 'request';
  return 'notification';
}
