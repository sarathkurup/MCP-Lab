/**
 * The extension <-> webview contract. Deliberately generic: a request/response
 * envelope plus a push-event envelope, so each new phase adds a method name
 * rather than a new message type and its plumbing.
 *
 * This module is shared by both sides and must not import vscode or node.
 */

export interface RpcRequest {
  channel: 'rpc';
  id: number;
  method: string;
  params?: unknown;
}

export interface RpcResponse {
  channel: 'rpc-result';
  id: number;
  result?: unknown;
  error?: { message: string; detail?: unknown };
}

export interface RpcEvent {
  channel: 'event';
  name: string;
  payload?: unknown;
}

export type HostMessage = RpcResponse | RpcEvent;
export type ViewMessage = RpcRequest;

export type RpcHandler = (params: unknown) => unknown | Promise<unknown>;

/** Extension side: dispatches incoming requests to registered handlers. */
export class RpcRouter {
  private readonly handlers = new Map<string, RpcHandler>();

  on(method: string, handler: RpcHandler): void {
    this.handlers.set(method, handler);
  }

  has(method: string): boolean {
    return this.handlers.has(method);
  }

  async dispatch(request: RpcRequest): Promise<RpcResponse> {
    const handler = this.handlers.get(request.method);
    if (!handler) {
      return {
        channel: 'rpc-result',
        id: request.id,
        error: { message: `No handler for "${request.method}"` },
      };
    }
    try {
      const result = await handler(request.params);
      return { channel: 'rpc-result', id: request.id, result };
    } catch (err) {
      return {
        channel: 'rpc-result',
        id: request.id,
        error: {
          message: err instanceof Error ? err.message : String(err),
          detail: err instanceof Error ? err.stack : undefined,
        },
      };
    }
  }
}

/** Webview side: promise-based calls over postMessage. */
export class RpcClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  >();
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();

  constructor(private readonly post: (message: ViewMessage) => void) {}

  handleMessage(message: HostMessage): void {
    if (message.channel === 'rpc-result') {
      const entry = this.pending.get(message.id);
      if (!entry) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        entry.reject(new Error(message.error.message));
      } else {
        entry.resolve(message.result);
      }
      return;
    }

    if (message.channel === 'event') {
      for (const listener of this.listeners.get(message.name) ?? []) {
        listener(message.payload);
      }
    }
  }

  call<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.post({ channel: 'rpc', id, method, params });
    });
  }

  on(name: string, listener: (payload: unknown) => void): () => void {
    const set = this.listeners.get(name) ?? new Set();
    set.add(listener);
    this.listeners.set(name, set);
    return () => set.delete(listener);
  }
}
