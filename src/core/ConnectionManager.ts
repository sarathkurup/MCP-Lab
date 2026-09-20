import type { ServerConfig } from './config';
import { Emitter } from './events';
import type { LogStore } from './logging';
import {
  McpConnection,
  type ConnectionStatusEvent,
  type McpConnectionDeps,
} from './McpConnection';
import type { TraceStore } from './trace';

export interface ConnectionManagerDeps {
  logs: LogStore;
  trace: TraceStore;
  requestTimeoutMs: () => number;
  authProvider?: (config: ServerConfig) => Promise<Record<string, string>>;
  maxReconnectAttempts?: () => number;
}

/**
 * Owns the set of live connections. The registry (persistence) is deliberately
 * separate: this class is handed configs and told what to do with them.
 */
export class ConnectionManager {
  private readonly connections = new Map<string, McpConnection>();
  private readonly statusChanged = new Emitter<ConnectionStatusEvent>();
  private readonly catalogChanged = new Emitter<string>();
  private readonly membershipChanged = new Emitter<void>();

  readonly onDidChangeStatus = this.statusChanged.on.bind(this.statusChanged);
  readonly onDidChangeCatalog = this.catalogChanged.on.bind(this.catalogChanged);
  readonly onDidChangeServers = this.membershipChanged.on.bind(this.membershipChanged);

  constructor(private readonly deps: ConnectionManagerDeps) {}

  private get connectionDeps(): McpConnectionDeps {
    return {
      logs: this.deps.logs,
      trace: this.deps.trace,
      requestTimeoutMs: this.deps.requestTimeoutMs,
      authProvider: this.deps.authProvider,
      maxReconnectAttempts: this.deps.maxReconnectAttempts,
    };
  }

  list(): McpConnection[] {
    return [...this.connections.values()].sort((a, b) =>
      a.config.name.localeCompare(b.config.name),
    );
  }

  get(serverId: string): McpConnection | undefined {
    return this.connections.get(serverId);
  }

  /** Adds a connection, or updates the config of one that already exists. */
  upsert(config: ServerConfig): McpConnection {
    const existing = this.connections.get(config.id);
    if (existing) {
      existing.config = config;
      this.membershipChanged.fire();
      return existing;
    }

    const connection = new McpConnection(config, this.connectionDeps);
    connection.onDidChangeStatus((event) => this.statusChanged.fire(event));
    connection.onDidChangeCatalog((id) => this.catalogChanged.fire(id));
    this.connections.set(config.id, connection);
    this.membershipChanged.fire();
    return connection;
  }

  /** Reconciles the live set with a full list of configs (settings reload, etc.). */
  async sync(configs: ServerConfig[]): Promise<void> {
    const wanted = new Set(configs.map((c) => c.id));

    for (const id of [...this.connections.keys()]) {
      if (!wanted.has(id)) {
        await this.remove(id);
      }
    }
    for (const config of configs) {
      this.upsert(config);
    }
    this.membershipChanged.fire();
  }

  async remove(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId);
    if (!connection) {
      return;
    }
    this.connections.delete(serverId);
    await connection.dispose();
    this.deps.trace.clear(serverId);
    this.deps.logs.clear(serverId);
    this.membershipChanged.fire();
  }

  async connect(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId);
    if (!connection) {
      throw new Error(`Unknown server "${serverId}"`);
    }
    await connection.connect();
  }

  async disconnect(serverId: string): Promise<void> {
    await this.connections.get(serverId)?.disconnect();
  }

  /** Connects every server marked autoConnect, reporting failures rather than throwing. */
  async connectAutoStart(): Promise<void> {
    const targets = this.list().filter((c) => c.config.autoConnect);
    await Promise.all(
      targets.map((connection) =>
        connection.connect().catch(() => {
          // The connection already logged and moved to the error state.
        }),
      ),
    );
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.connections.values()].map((c) => c.dispose()));
    this.connections.clear();
    this.statusChanged.dispose();
    this.catalogChanged.dispose();
    this.membershipChanged.dispose();
  }
}
