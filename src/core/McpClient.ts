import { Emitter } from './events';
import {
  ErrorCode,
  LATEST_PROTOCOL_VERSION,
  McpError,
  SUPPORTED_PROTOCOL_VERSIONS,
  isJsonRpcFailure,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  type CallToolResult,
  type ClientCapabilities,
  type GetPromptResult,
  type Implementation,
  type InitializeResult,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type ListPromptsResult,
  type ListResourceTemplatesResult,
  type ListResourcesResult,
  type ListToolsResult,
  type LoggingLevel,
  type LoggingMessageNotification,
  type Prompt,
  type ReadResourceResult,
  type Resource,
  type ResourceTemplate,
  type ServerCapabilities,
  type Tool,
} from './protocol';
import type { Transport } from './transport/Transport';

export interface McpClientOptions {
  clientInfo?: Implementation;
  capabilities?: ClientCapabilities;
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: McpError) => void;
  method: string;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Speaks MCP over a Transport: correlates requests, runs the initialize
 * handshake, and exposes the primitives. Knows nothing about VS Code or UI.
 */
export class McpClient {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private initialized = false;
  private closed = false;

  private serverInfo?: Implementation;
  private serverCapabilities?: ServerCapabilities;
  private negotiatedVersion?: string;
  private serverInstructions?: string;

  private readonly outgoing = new Emitter<JsonRpcMessage>();
  private readonly incoming = new Emitter<JsonRpcMessage>();
  private readonly notifications = new Emitter<JsonRpcNotification>();
  private readonly serverLogs = new Emitter<LoggingMessageNotification>();
  private readonly stderr = new Emitter<string>();
  private readonly errors = new Emitter<Error>();
  private readonly closedEvent = new Emitter<string | undefined>();

  /** Every frame Workbench sends, before it hits the wire. */
  readonly onDidSend = this.outgoing.on.bind(this.outgoing);
  /** Every frame received, before it is dispatched. */
  readonly onDidReceive = this.incoming.on.bind(this.incoming);
  readonly onNotification = this.notifications.on.bind(this.notifications);
  readonly onServerLog = this.serverLogs.on.bind(this.serverLogs);
  readonly onStderr = this.stderr.on.bind(this.stderr);
  readonly onError = this.errors.on.bind(this.errors);
  readonly onClose = this.closedEvent.on.bind(this.closedEvent);

  constructor(
    private readonly transport: Transport,
    private readonly options: McpClientOptions = {},
  ) {
    transport.onMessage = (message) => this.handleMessage(message);
    transport.onError = (error) => this.errors.fire(error);
    transport.onStderr = (chunk) => this.stderr.fire(chunk);
    transport.onClose = (reason) => this.handleClose(reason);
  }

  get capabilities(): ServerCapabilities | undefined {
    return this.serverCapabilities;
  }

  get info(): Implementation | undefined {
    return this.serverInfo;
  }

  get protocolVersion(): string | undefined {
    return this.negotiatedVersion;
  }

  get instructions(): string | undefined {
    return this.serverInstructions;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async initialize(): Promise<InitializeResult> {
    await this.transport.start();

    const result = (await this.request('initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: this.options.capabilities ?? {},
      clientInfo: this.options.clientInfo ?? {
        name: 'mcplab',
        title: 'MCP Lab',
        version: '0.1.0',
      },
    })) as InitializeResult;

    if (!result?.protocolVersion) {
      throw new McpError(ErrorCode.InternalError, 'initialize returned no protocolVersion');
    }
    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(result.protocolVersion)) {
      throw new McpError(
        ErrorCode.InternalError,
        `Server speaks protocol ${result.protocolVersion}; MCP Lab supports ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}`,
      );
    }

    this.negotiatedVersion = result.protocolVersion;
    this.serverCapabilities = result.capabilities ?? {};
    this.serverInfo = result.serverInfo;
    this.serverInstructions = result.instructions;

    const maybeVersioned = this.transport as Transport & {
      setProtocolVersion?: (v: string) => void;
      openServerStream?: () => Promise<void>;
    };
    maybeVersioned.setProtocolVersion?.(result.protocolVersion);

    await this.notify('notifications/initialized');
    this.initialized = true;

    // Best effort; servers without a server->client stream simply decline.
    await maybeVersioned.openServerStream?.();

    return result;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.rejectAllPending(new McpError(ErrorCode.ConnectionClosed, 'Connection closed'));
    await this.transport.close();
  }

  // -------------------------------------------------------------------------
  // Primitives
  // -------------------------------------------------------------------------

  async listTools(): Promise<Tool[]> {
    this.assertCapability('tools', 'tools/list');
    return this.paginate<Tool>('tools/list', (page) => (page as ListToolsResult).tools ?? []);
  }

  async callTool(name: string, args: unknown): Promise<CallToolResult> {
    this.assertCapability('tools', 'tools/call');
    return (await this.request('tools/call', {
      name,
      arguments: args ?? {},
    })) as CallToolResult;
  }

  async listResources(): Promise<Resource[]> {
    this.assertCapability('resources', 'resources/list');
    return this.paginate<Resource>(
      'resources/list',
      (page) => (page as ListResourcesResult).resources ?? [],
    );
  }

  async listResourceTemplates(): Promise<ResourceTemplate[]> {
    this.assertCapability('resources', 'resources/templates/list');
    try {
      return await this.paginate<ResourceTemplate>(
        'resources/templates/list',
        (page) => (page as ListResourceTemplatesResult).resourceTemplates ?? [],
      );
    } catch (err) {
      // Templates are optional even when resources are advertised.
      if (err instanceof McpError && err.code === ErrorCode.MethodNotFound) {
        return [];
      }
      throw err;
    }
  }

  async readResource(uri: string): Promise<ReadResourceResult> {
    this.assertCapability('resources', 'resources/read');
    return (await this.request('resources/read', { uri })) as ReadResourceResult;
  }

  async listPrompts(): Promise<Prompt[]> {
    this.assertCapability('prompts', 'prompts/list');
    return this.paginate<Prompt>(
      'prompts/list',
      (page) => (page as ListPromptsResult).prompts ?? [],
    );
  }

  async getPrompt(name: string, args?: Record<string, string>): Promise<GetPromptResult> {
    this.assertCapability('prompts', 'prompts/get');
    return (await this.request('prompts/get', {
      name,
      arguments: args ?? {},
    })) as GetPromptResult;
  }

  async setLoggingLevel(level: LoggingLevel): Promise<void> {
    this.assertCapability('logging', 'logging/setLevel');
    await this.request('logging/setLevel', { level });
  }

  async ping(): Promise<void> {
    await this.request('ping', {});
  }

  // -------------------------------------------------------------------------
  // Transport plumbing
  // -------------------------------------------------------------------------

  async request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) {
      throw new McpError(ErrorCode.ConnectionClosed, 'Connection is closed');
    }

    const id = this.nextId++;
    const message: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    const timeoutMs = this.options.requestTimeoutMs ?? 30_000;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Tell the server to stop working on something nobody is waiting for.
        void this.notify('notifications/cancelled', {
          requestId: id,
          reason: 'Client timeout',
        }).catch(() => undefined);
        reject(
          new McpError(
            ErrorCode.RequestTimeout,
            `Request "${method}" timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, method, timer });
      this.outgoing.fire(message);

      this.transport.send(message).catch((err: unknown) => {
        const entry = this.pending.get(id);
        if (entry) {
          clearTimeout(entry.timer);
          this.pending.delete(id);
        }
        reject(toMcpError(err));
      });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const message: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    this.outgoing.fire(message);
    await this.transport.send(message);
  }

  private async paginate<T>(
    method: string,
    pick: (page: unknown) => T[],
  ): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | undefined;
    // Guard against a server that keeps handing back the same cursor.
    const seen = new Set<string>();

    do {
      const page = (await this.request(method, cursor ? { cursor } : {})) as {
        nextCursor?: string;
      };
      items.push(...pick(page));
      cursor = page?.nextCursor;
      if (cursor) {
        if (seen.has(cursor)) {
          break;
        }
        seen.add(cursor);
      }
    } while (cursor);

    return items;
  }

  private handleMessage(message: JsonRpcMessage): void {
    this.incoming.fire(message);

    if (isJsonRpcResponse(message)) {
      const id = message.id;
      if (id === null || id === undefined) {
        return;
      }
      const entry = this.pending.get(id);
      if (!entry) {
        return;
      }
      clearTimeout(entry.timer);
      this.pending.delete(id);

      if (isJsonRpcFailure(message)) {
        entry.reject(
          new McpError(message.error.code, message.error.message, message.error.data),
        );
      } else {
        entry.resolve(message.result);
      }
      return;
    }

    if (isJsonRpcRequest(message)) {
      // Workbench advertises no server->client capabilities yet (sampling,
      // roots and elicitation arrive in a later phase), so decline politely
      // instead of leaving the server waiting.
      void this.transport
        .send({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: ErrorCode.MethodNotFound,
            message: `MCP Lab does not implement "${message.method}" yet`,
          },
        })
        .catch(() => undefined);
      return;
    }

    if (isJsonRpcNotification(message)) {
      if (message.method === 'notifications/message') {
        this.serverLogs.fire(message.params as LoggingMessageNotification);
      }
      this.notifications.fire(message);
    }
  }

  private handleClose(reason?: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.rejectAllPending(
      new McpError(ErrorCode.ConnectionClosed, reason ?? 'Connection closed'),
    );
    this.closedEvent.fire(reason);
  }

  private rejectAllPending(error: McpError): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  private assertCapability(
    capability: keyof ServerCapabilities,
    method: string,
  ): void {
    if (!this.initialized) {
      throw new McpError(ErrorCode.InvalidRequest, `Call initialize() before ${method}`);
    }
    if (!this.serverCapabilities?.[capability]) {
      throw new McpError(
        ErrorCode.MethodNotFound,
        `Server does not advertise the "${capability}" capability required by ${method}`,
      );
    }
  }
}

function toMcpError(err: unknown): McpError {
  if (err instanceof McpError) {
    return err;
  }
  const message = err instanceof Error ? err.message : String(err);
  return new McpError(ErrorCode.ConnectionClosed, message, err);
}
