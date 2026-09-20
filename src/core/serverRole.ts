import {
  ErrorCode,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  type CallToolResult,
  type JsonRpcMessage,
  type JsonRpcResponse,
  type Tool,
} from './protocol';

/**
 * The other half of the protocol: Workbench acting as an MCP *server*.
 *
 * This is what lets an AI client reach the servers Workbench already manages -
 * one connection instead of N, with Workbench's guards in front of them.
 * Transport-free and UI-free, so it can be hosted over HTTP, a pipe, or stdio.
 */

export interface ServerToolDefinition {
  tool: Tool;
  handler: (args: Record<string, unknown>) => Promise<CallToolResult> | CallToolResult;
}

export interface ServerRoleOptions {
  name: string;
  version: string;
  instructions?: string;
  /** Called before any tool runs; returning false rejects the call. */
  authorize?: (toolName: string, args: Record<string, unknown>) => Promise<boolean> | boolean;
  onLog?: (message: string) => void;
}

export class McpServerRole {
  private readonly tools = new Map<string, ServerToolDefinition>();
  private initialized = false;

  constructor(private readonly options: ServerRoleOptions) {}

  register(definition: ServerToolDefinition): void {
    this.tools.set(definition.tool.name, definition);
  }

  list(): Tool[] {
    return [...this.tools.values()].map((definition) => definition.tool);
  }

  /** Handles one inbound message; returns undefined for notifications. */
  async handle(message: JsonRpcMessage): Promise<JsonRpcResponse | undefined> {
    const id = 'id' in message ? message.id : undefined;
    const method = 'method' in message ? message.method : undefined;

    if (id === undefined || id === null) {
      if (method === 'notifications/initialized') {
        this.initialized = true;
      }
      return undefined;
    }

    const ok = (result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
    const fail = (code: number, text: string): JsonRpcResponse => ({
      jsonrpc: '2.0',
      id,
      error: { code, message: text },
    });

    const params = ('params' in message ? message.params : {}) as Record<string, unknown>;

    switch (method) {
      case 'initialize': {
        const requested = String(params.protocolVersion ?? LATEST_PROTOCOL_VERSION);
        // Answer in the client's version when we know it, so old clients still work.
        const negotiated = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : LATEST_PROTOCOL_VERSION;
        return ok({
          protocolVersion: negotiated,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: this.options.name, version: this.options.version },
          instructions: this.options.instructions,
        });
      }

      case 'ping':
        return ok({});

      case 'tools/list':
        return ok({ tools: this.list() });

      case 'tools/call': {
        const name = String(params.name ?? '');
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        const definition = this.tools.get(name);
        if (!definition) {
          return fail(ErrorCode.InvalidParams, `Unknown tool "${name}"`);
        }

        if (this.options.authorize) {
          const allowed = await this.options.authorize(name, args);
          if (!allowed) {
            // A refusal is reported in-band so the model can explain it.
            return ok({
              isError: true,
              content: [
                {
                  type: 'text',
                  text: `"${name}" was not authorized. MCPilot requires a human to approve this operation.`,
                },
              ],
            } satisfies CallToolResult);
          }
        }

        try {
          const result = await definition.handler(args);
          return ok(result);
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          this.options.onLog?.(`tools/call ${name} failed: ${text}`);
          return ok({
            isError: true,
            content: [{ type: 'text', text }],
          } satisfies CallToolResult);
        }
      }

      default:
        return fail(ErrorCode.MethodNotFound, `Method not found: ${method}`);
    }
  }

  get isInitialized(): boolean {
    return this.initialized;
  }
}

/** Convenience for handlers: a text result. */
export function textResult(text: string, structured?: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(structured !== undefined ? { structuredContent: structured } : {}),
  };
}

/** Convenience for handlers: a JSON result, both readable and structured. */
export function jsonResult(value: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}
