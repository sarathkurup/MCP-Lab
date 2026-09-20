import type { ConnectionManager } from './ConnectionManager';
import { Emitter } from './events';
import { HistoryStore, newInvocationId, type HistoryEntry, type InvocationKind } from './history';
import type { McpClient } from './McpClient';
import { McpError, type CallToolResult, type GetPromptResult, type ReadResourceResult } from './protocol';
import { normalizeSchema, pruneEmpty, validateValue, type ValidationError } from './schema';

export interface ExecuteOptions {
  /** Skip the client-side schema check (raw JSON mode deliberately allows this). */
  skipValidation?: boolean;
  /** Drop empty optional fields before sending. Defaults to true. */
  prune?: boolean;
  environment?: string;
}

export interface ExecutionResult<T> {
  entry: HistoryEntry;
  result?: T;
  error?: McpError;
}

export class ValidationFailure extends Error {
  constructor(readonly errors: ValidationError[]) {
    super(
      `Request does not match the tool's input schema:\n` +
        errors.map((e) => `  • ${e.path}: ${e.message}`).join('\n'),
    );
    this.name = 'ValidationFailure';
  }
}

/**
 * The single path every invocation takes: validate, call, time, record.
 * Tool execution, replay, tests, workflows and the AI bridge all go through here,
 * so history and analytics can never drift from what actually ran.
 */
export class ExecutionService {
  private readonly executed = new Emitter<HistoryEntry>();
  readonly onDidExecute = this.executed.on.bind(this.executed);

  constructor(
    private readonly manager: ConnectionManager,
    readonly history: HistoryStore,
  ) {}

  async callTool(
    serverId: string,
    toolName: string,
    args: unknown,
    options: ExecuteOptions = {},
  ): Promise<ExecutionResult<CallToolResult>> {
    const connection = this.requireConnection(serverId);
    const tool = connection.catalog.tools.find((t) => t.name === toolName);
    if (!tool) {
      throw new Error(`Server "${connection.config.name}" has no tool "${toolName}"`);
    }

    let payload: unknown = args ?? {};
    if (!options.skipValidation) {
      const spec = normalizeSchema(tool.inputSchema);
      if (options.prune !== false) {
        payload = pruneEmpty(spec, payload);
      }
      const errors = validateValue(spec, payload);
      if (errors.length > 0) {
        throw new ValidationFailure(errors);
      }
    }

    return this.run('tool', serverId, toolName, payload, options, async (client) => {
      const result = await client.callTool(toolName, payload);
      return { result, toolError: result.isError === true };
    });
  }

  async readResource(
    serverId: string,
    uri: string,
    options: ExecuteOptions = {},
  ): Promise<ExecutionResult<ReadResourceResult>> {
    return this.run('resource', serverId, uri, { uri }, options, async (client) => ({
      result: await client.readResource(uri),
      toolError: false,
    }));
  }

  async getPrompt(
    serverId: string,
    name: string,
    args: Record<string, string>,
    options: ExecuteOptions = {},
  ): Promise<ExecutionResult<GetPromptResult>> {
    return this.run('prompt', serverId, name, args, options, async (client) => ({
      result: await client.getPrompt(name, args),
      toolError: false,
    }));
  }

  /** Re-runs a stored invocation exactly as it was sent. */
  async replay(historyId: string): Promise<ExecutionResult<unknown>> {
    const entry = this.history.get(historyId);
    if (!entry) {
      throw new Error(`No history entry "${historyId}"`);
    }
    switch (entry.kind) {
      case 'tool':
        // Replay must reproduce the original bytes, so validation is skipped.
        return this.callTool(entry.serverId, entry.name, entry.input, {
          skipValidation: true,
          prune: false,
        });
      case 'resource':
        return this.readResource(entry.serverId, entry.name);
      case 'prompt':
        return this.getPrompt(
          entry.serverId,
          entry.name,
          (entry.input ?? {}) as Record<string, string>,
        );
    }
  }

  private async run<T>(
    kind: InvocationKind,
    serverId: string,
    name: string,
    input: unknown,
    options: ExecuteOptions,
    invoke: (client: McpClient) => Promise<{ result: T; toolError: boolean }>,
  ): Promise<ExecutionResult<T>> {
    const connection = this.requireConnection(serverId);
    const client = connection.activeClient;
    if (!client) {
      throw new Error(`"${connection.config.name}" is not connected`);
    }

    const started = Date.now();
    const base = {
      id: newInvocationId(),
      timestamp: started,
      serverId,
      serverName: connection.config.name,
      kind,
      name,
      input,
      environment: options.environment,
    };

    try {
      const { result, toolError } = await invoke(client);
      const entry: HistoryEntry = {
        ...base,
        output: result,
        durationMs: Date.now() - started,
        toolError,
      };
      this.history.add(entry);
      this.executed.fire(entry);
      return { entry, result };
    } catch (err) {
      const error =
        err instanceof McpError
          ? err
          : new McpError(-32603, err instanceof Error ? err.message : String(err));
      const entry: HistoryEntry = {
        ...base,
        error: { code: error.code, message: error.message, data: error.data },
        durationMs: Date.now() - started,
      };
      this.history.add(entry);
      this.executed.fire(entry);
      return { entry, error };
    }
  }

  private requireConnection(serverId: string) {
    const connection = this.manager.get(serverId);
    if (!connection) {
      throw new Error(`Unknown server "${serverId}"`);
    }
    return connection;
  }
}
