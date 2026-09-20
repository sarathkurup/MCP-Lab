import type { ServerConfig } from './config';
import { describeTarget } from './config';
import { Emitter } from './events';
import { LogStore } from './logging';
import { McpClient } from './McpClient';
import type {
  Implementation,
  LoggingMessageNotification,
  Prompt,
  Resource,
  ResourceTemplate,
  ServerCapabilities,
  Tool,
} from './protocol';
import { StdioTransport } from './transport/StdioTransport';
import { StreamableHttpTransport } from './transport/StreamableHttpTransport';
import type { Transport } from './transport/Transport';
import { TraceStore } from './trace';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ServerCatalog {
  tools: Tool[];
  resources: Resource[];
  resourceTemplates: ResourceTemplate[];
  prompts: Prompt[];
}

export interface ConnectionStatusEvent {
  serverId: string;
  status: ConnectionStatus;
  error?: string;
}

export interface McpConnectionDeps {
  logs: LogStore;
  trace: TraceStore;
  requestTimeoutMs: () => number;
  /** Extra headers (e.g. Authorization) resolved per request; never stored in config. */
  authProvider?: (config: ServerConfig) => Promise<Record<string, string>>;
  /** How many times to retry a dropped connection. 0 disables it. */
  maxReconnectAttempts?: () => number;
}

/** A connection that lasted this long is treated as healthy, not flapping. */
const STABLE_CONNECTION_MS = 30_000;

const EMPTY_CATALOG: ServerCatalog = {
  tools: [],
  resources: [],
  resourceTemplates: [],
  prompts: [],
};

/**
 * One configured server: owns its transport, its client, its status and the
 * catalog of what it exposes. The UI observes this; it never drives the client.
 */
export class McpConnection {
  private client?: McpClient;
  private transport?: Transport;
  private currentStatus: ConnectionStatus = 'disconnected';
  private lastErrorMessage?: string;
  private currentCatalog: ServerCatalog = EMPTY_CATALOG;
  private connectPromise?: Promise<void>;
  private reconnectAttempt = 0;
  private connectedAt?: number;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  /** Set when the user asked to disconnect, which must not trigger a retry. */
  private intentionalDisconnect = false;

  private readonly statusChanged = new Emitter<ConnectionStatusEvent>();
  private readonly catalogChanged = new Emitter<string>();

  readonly onDidChangeStatus = this.statusChanged.on.bind(this.statusChanged);
  readonly onDidChangeCatalog = this.catalogChanged.on.bind(this.catalogChanged);

  constructor(
    public config: ServerConfig,
    private readonly deps: McpConnectionDeps,
  ) {}

  get id(): string {
    return this.config.id;
  }

  get status(): ConnectionStatus {
    return this.currentStatus;
  }

  get lastError(): string | undefined {
    return this.lastErrorMessage;
  }

  get catalog(): ServerCatalog {
    return this.currentCatalog;
  }

  get serverInfo(): Implementation | undefined {
    return this.client?.info;
  }

  get capabilities(): ServerCapabilities | undefined {
    return this.client?.capabilities;
  }

  get protocolVersion(): string | undefined {
    return this.client?.protocolVersion;
  }

  get instructions(): string | undefined {
    return this.client?.instructions;
  }

  /** The live client, for callers that need a primitive directly. */
  get activeClient(): McpClient | undefined {
    return this.currentStatus === 'connected' ? this.client : undefined;
  }

  async connect(): Promise<void> {
    this.intentionalDisconnect = false;
    if (this.currentStatus === 'connected') {
      return;
    }
    // Collapse concurrent connect() calls (tree refresh + auto-connect racing).
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = this.doConnect().finally(() => {
      this.connectPromise = undefined;
    });
    return this.connectPromise;
  }

  private async doConnect(): Promise<void> {
    this.setStatus('connecting');
    this.lastErrorMessage = undefined;
    this.log('info', `Connecting to ${this.config.name} (${describeTarget(this.config)})`);

    try {
      this.transport = this.createTransport();
      this.client = new McpClient(this.transport, {
        requestTimeoutMs: this.deps.requestTimeoutMs(),
      });
      this.wireClient(this.client);

      const result = await this.client.initialize();
      this.log(
        'info',
        `Initialized: ${result.serverInfo?.name ?? 'unknown server'} ` +
          `v${result.serverInfo?.version ?? '?'} (protocol ${result.protocolVersion})`,
      );

      this.connectedAt = Date.now();
      this.setStatus('connected');
      await this.refreshCatalog();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastErrorMessage = message;
      this.log('error', `Connection failed: ${message}`);
      await this.teardown();
      this.setStatus('error', message);
      throw err;
    }
  }

  private createTransport(): Transport {
    if (this.config.transport === 'stdio') {
      if (!this.config.command) {
        throw new Error('stdio server has no command configured');
      }
      return new StdioTransport({
        command: this.config.command,
        args: this.config.args,
        cwd: this.config.cwd,
        env: this.config.env,
      });
    }

    if (!this.config.url) {
      throw new Error('HTTP server has no URL configured');
    }
    return new StreamableHttpTransport({
      url: this.config.url,
      headers: this.config.headers,
      authProvider: this.deps.authProvider
        ? () => this.deps.authProvider!(this.config)
        : undefined,
    });
  }

  private wireClient(client: McpClient): void {
    client.onDidSend((message) =>
      this.deps.trace.record(this.id, 'client->server', message),
    );
    client.onDidReceive((message) =>
      this.deps.trace.record(this.id, 'server->client', message),
    );
    client.onStderr((chunk) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim()) {
          this.deps.logs.log('info', line, { serverId: this.id, source: 'stderr' });
        }
      }
    });
    client.onServerLog((entry) => this.appendServerLog(entry));
    client.onError((error) => this.log('error', error.message));
    client.onNotification((notification) => {
      if (
        notification.method === 'notifications/tools/list_changed' ||
        notification.method === 'notifications/resources/list_changed' ||
        notification.method === 'notifications/prompts/list_changed'
      ) {
        this.log('info', `Server announced ${notification.method}; refreshing catalog`);
        void this.refreshCatalog();
      }
    });
    client.onClose((reason) => {
      if (this.currentStatus === 'disconnected' || this.intentionalDisconnect) {
        return;
      }
      this.lastErrorMessage = reason;
      this.log('warn', reason ?? 'Connection closed by server');
      this.currentCatalog = EMPTY_CATALOG;
      this.setStatus('error', reason);

      // Only a connection that stayed up earns a fresh budget of retries.
      if (this.connectedAt && Date.now() - this.connectedAt >= STABLE_CONNECTION_MS) {
        this.reconnectAttempt = 0;
      }
      this.connectedAt = undefined;
      this.scheduleReconnect();
    });
  }

  private appendServerLog(entry: LoggingMessageNotification): void {
    const level =
      entry.level === 'debug'
        ? 'debug'
        : entry.level === 'info' || entry.level === 'notice'
          ? 'info'
          : entry.level === 'warning'
            ? 'warn'
            : 'error';
    const text =
      typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data);
    this.deps.logs.log(level, entry.logger ? `[${entry.logger}] ${text}` : text, {
      serverId: this.id,
      source: 'server',
    });
  }

  /** Re-reads tools, resources, templates and prompts, gated on capabilities. */
  async refreshCatalog(): Promise<ServerCatalog> {
    const client = this.activeClient;
    if (!client) {
      this.currentCatalog = EMPTY_CATALOG;
      this.catalogChanged.fire(this.id);
      return this.currentCatalog;
    }

    const caps = client.capabilities ?? {};
    const next: ServerCatalog = {
      tools: [],
      resources: [],
      resourceTemplates: [],
      prompts: [],
    };

    // A failure in one primitive must not blank out the others.
    if (caps.tools) {
      next.tools = await this.safeList('tools', () => client.listTools());
    }
    if (caps.resources) {
      next.resources = await this.safeList('resources', () => client.listResources());
      next.resourceTemplates = await this.safeList('resource templates', () =>
        client.listResourceTemplates(),
      );
    }
    if (caps.prompts) {
      next.prompts = await this.safeList('prompts', () => client.listPrompts());
    }

    this.currentCatalog = next;
    this.log(
      'info',
      `Catalog: ${next.tools.length} tools, ${next.resources.length} resources, ` +
        `${next.resourceTemplates.length} templates, ${next.prompts.length} prompts`,
    );
    this.catalogChanged.fire(this.id);
    return next;
  }

  private async safeList<T>(label: string, run: () => Promise<T[]>): Promise<T[]> {
    try {
      return await run();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log('warn', `Failed to list ${label}: ${message}`);
      return [];
    }
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    this.cancelReconnect();
    if (this.currentStatus === 'disconnected') {
      return;
    }
    this.log('info', `Disconnecting from ${this.config.name}`);
    await this.teardown();
    this.currentCatalog = EMPTY_CATALOG;
    this.lastErrorMessage = undefined;
    this.setStatus('disconnected');
    this.catalogChanged.fire(this.id);
  }

  async reconnect(): Promise<void> {
    await this.disconnect();
    this.intentionalDisconnect = false;
    await this.connect();
  }

  /**
   * Retries a *dropped* connection with exponential backoff - a server
   * restarted by its own build step is the common case. A failed initial
   * connect is not retried: the user asked for it explicitly and deserves the
   * error, rather than a background loop against a server that will not start.
   */
  private scheduleReconnect(): void {
    const limit = this.deps.maxReconnectAttempts?.() ?? 5;
    if (limit <= 0 || this.reconnectAttempt >= limit) {
      if (limit > 0) {
        this.log('warn', `Giving up after ${this.reconnectAttempt} reconnection attempt(s)`);
      }
      return;
    }

    this.reconnectAttempt++;
    const delay = Math.min(30_000, 500 * 2 ** (this.reconnectAttempt - 1));
    this.log('info', `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt}/${limit})`);

    this.cancelReconnect();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.intentionalDisconnect) {
        return;
      }
      void this.connect().catch(() => {
        // doConnect already logged; schedule the next attempt from here so a
        // server that is down stays retried rather than retried once.
        this.scheduleReconnect();
      });
    }, delay);
    // A pending retry must not hold the process open in the CLI.
    this.reconnectTimer.unref?.();
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private async teardown(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.transport = undefined;
    if (client) {
      try {
        await client.close();
      } catch {
        // Closing a already-dead connection is not worth reporting.
      }
    }
  }

  async dispose(): Promise<void> {
    this.intentionalDisconnect = true;
    this.cancelReconnect();
    await this.teardown();
    this.statusChanged.dispose();
    this.catalogChanged.dispose();
  }

  private setStatus(status: ConnectionStatus, error?: string): void {
    if (this.currentStatus === status && this.lastErrorMessage === error) {
      return;
    }
    this.currentStatus = status;
    this.statusChanged.fire({ serverId: this.id, status, error });
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    this.deps.logs.log(level, message, { serverId: this.id, source: 'mcplab' });
  }
}
