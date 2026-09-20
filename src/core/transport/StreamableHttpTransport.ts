import type { JsonRpcMessage } from '../protocol';
import { TransportError, type Transport } from './Transport';

export interface StreamableHttpTransportOptions {
  url: string;
  /** Static headers, including any Authorization built by the caller. */
  headers?: Record<string, string>;
  /** Resolved lazily on every request so a rotated token is picked up. */
  authProvider?: () => Promise<Record<string, string>>;
  fetchImpl?: typeof fetch;
}

/**
 * Streamable HTTP transport. A POST carries client->server messages; the reply
 * is either a single JSON message, an SSE stream of them, or 202 for fire-and-forget.
 * An optional GET stream carries server-initiated messages.
 */
export class StreamableHttpTransport implements Transport {
  readonly kind = 'http';

  onMessage?: (message: JsonRpcMessage) => void;
  onError?: (error: Error) => void;
  onClose?: (reason?: string) => void;
  onStderr?: (chunk: string) => void;

  private sessionId?: string;
  private protocolVersion?: string;
  private closed = false;
  private readonly abort = new AbortController();
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: StreamableHttpTransportOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (!this.fetchImpl) {
      throw new TransportError('global fetch is unavailable; Node 18+ is required');
    }
  }

  /** Set by the client once `initialize` returns, so later requests are version-tagged. */
  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }

  async start(): Promise<void> {
    // Streamable HTTP has no connect handshake of its own; `initialize` is the
    // first POST and establishes the session.
    this.closed = false;
  }

  private async buildHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(this.options.headers ?? {}),
    };
    if (this.sessionId) {
      headers['mcp-session-id'] = this.sessionId;
    }
    if (this.protocolVersion) {
      headers['mcp-protocol-version'] = this.protocolVersion;
    }
    if (this.options.authProvider) {
      Object.assign(headers, await this.options.authProvider());
    }
    return headers;
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.closed) {
      throw new TransportError('Transport is closed');
    }

    let response: Response;
    try {
      response = await this.fetchImpl(this.options.url, {
        method: 'POST',
        headers: await this.buildHeaders(),
        body: JSON.stringify(message),
        signal: this.abort.signal,
      });
    } catch (err) {
      throw new TransportError(`POST ${this.options.url} failed: ${errorText(err)}`, err);
    }

    const session = response.headers.get('mcp-session-id');
    if (session) {
      this.sessionId = session;
    }

    if (response.status === 404 && this.sessionId) {
      // The server forgot our session; surface it as a disconnect, not a request error.
      this.sessionId = undefined;
      this.onClose?.('Server session expired (HTTP 404)');
      throw new TransportError('MCP session expired');
    }

    if (!response.ok) {
      const body = await safeText(response);
      throw new TransportError(
        `HTTP ${response.status} ${response.statusText}${body ? ': ' + truncate(body) : ''}`,
      );
    }

    if (response.status === 202 || !response.body) {
      return;
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      void this.pumpEventStream(response.body, 'post');
      return;
    }

    if (contentType.includes('application/json')) {
      const payload = (await response.json()) as JsonRpcMessage | JsonRpcMessage[];
      for (const msg of Array.isArray(payload) ? payload : [payload]) {
        this.onMessage?.(msg);
      }
      return;
    }

    const text = await safeText(response);
    if (text.trim()) {
      this.onError?.(new TransportError(`Unexpected content-type "${contentType}"`));
    }
  }

  /**
   * Opens the optional GET stream for server-initiated messages. A 405 simply
   * means the server does not offer one, which is legal.
   */
  async openServerStream(): Promise<void> {
    if (this.closed) {
      return;
    }
    try {
      const headers = await this.buildHeaders();
      headers.accept = 'text/event-stream';
      delete headers['content-type'];
      const response = await this.fetchImpl(this.options.url, {
        method: 'GET',
        headers,
        signal: this.abort.signal,
      });
      if (response.status === 405 || response.status === 501) {
        return;
      }
      if (!response.ok || !response.body) {
        return;
      }
      void this.pumpEventStream(response.body, 'get');
    } catch (err) {
      if (!this.closed) {
        this.onStderr?.(`server stream unavailable: ${errorText(err)}\n`);
      }
    }
  }

  private async pumpEventStream(
    body: ReadableStream<Uint8Array>,
    origin: 'post' | 'get',
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let boundary = findEventBoundary(buffer);
        while (boundary) {
          const raw = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary.length);
          this.dispatchSseEvent(raw);
          boundary = findEventBoundary(buffer);
        }
      }
    } catch (err) {
      if (!this.closed) {
        this.onError?.(
          new TransportError(`Event stream (${origin}) failed: ${errorText(err)}`, err),
        );
      }
    } finally {
      reader.releaseLock();
    }
  }

  private dispatchSseEvent(raw: string): void {
    const dataLines: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length === 0) {
      return;
    }
    const data = dataLines.join('\n');
    try {
      const payload = JSON.parse(data) as JsonRpcMessage | JsonRpcMessage[];
      for (const msg of Array.isArray(payload) ? payload : [payload]) {
        this.onMessage?.(msg);
      }
    } catch (err) {
      this.onError?.(new TransportError(`Malformed SSE payload: ${truncate(data)}`, err));
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    if (this.sessionId) {
      try {
        const headers = await this.buildHeaders();
        delete headers['content-type'];
        await this.fetchImpl(this.options.url, { method: 'DELETE', headers });
      } catch {
        // Best effort: the session will time out server-side anyway.
      }
    }
    this.abort.abort();
  }
}

function findEventBoundary(buffer: string): { index: number; length: number } | undefined {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) {
    return undefined;
  }
  if (crlf !== -1 && (lf === -1 || crlf < lf)) {
    return { index: crlf, length: 4 };
  }
  return { index: lf, length: 2 };
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncate(value: string, max = 300): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
