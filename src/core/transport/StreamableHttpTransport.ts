import { describeNetworkFailure } from '../netErrors';
import { sanitizeUrl } from '../oauth';
import type { JsonRpcMessage } from '../protocol';
import { TransportError, type Transport } from './Transport';

export interface UnauthorizedContext {
  error: TransportError;
  /** The Authorization header the rejected request carried, if any. */
  authorization?: string;
}

export interface StreamableHttpTransportOptions {
  url: string;
  /** Static headers, including any Authorization built by the caller. */
  headers?: Record<string, string>;
  /**
   * Resolved lazily on every request so a rotated token is picked up. Told the
   * URL the request is going to, so a credential can refuse to travel anywhere
   * it does not belong.
   */
  authProvider?: (requestUrl: string) => Promise<Record<string, string>>;
  /**
   * Called once when a request is rejected with 401. Resolve true to retry that
   * request a single time (after refreshing a token, say); a second 401 is
   * final, so a server that never accepts the credential cannot cause a loop.
   */
  onUnauthorized?: (context: UnauthorizedContext) => Promise<boolean>;
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
      Object.assign(headers, await this.options.authProvider(this.options.url));
    }
    return headers;
  }

  /**
   * One HTTP exchange. A request that carries credentials does not follow
   * redirects: following one would hand the bearer token to whatever host the
   * Location header names. The redirect is reported instead.
   */
  private async request(
    init: { method: string; body?: string },
    headers: Record<string, string>,
  ): Promise<Response> {
    const credentialed = 'authorization' in headers;
    let response: Response;
    try {
      response = await this.fetchImpl(this.options.url, {
        ...init,
        headers,
        signal: this.abort.signal,
        redirect: credentialed ? 'manual' : 'follow',
      });
    } catch (err) {
      const failure = describeNetworkFailure(err);
      throw new TransportError(
        `${init.method} ${sanitizeUrl(this.options.url)} failed: ${failure.message}` +
          (failure.hint ? `. ${failure.hint}` : ''),
        err,
      );
    }
    if (credentialed && (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400))) {
      const location = response.headers.get('location');
      let target = 'another location';
      try {
        target = location ? new URL(location, this.options.url).origin : target;
      } catch {
        // keep the generic wording
      }
      await response.body?.cancel().catch(() => undefined);
      const error = new TransportError(
        `The MCP endpoint redirected (HTTP ${response.status || 'redirect'}) to ${target}. ` +
          'Credentials are never forwarded across a redirect; update the MCP URL to the final address.',
      );
      error.status = response.status || undefined;
      throw error;
    }
    return response;
  }

  private async httpError(response: Response): Promise<TransportError> {
    const body = await safeText(response);
    const error = new TransportError(
      `HTTP ${response.status} ${response.statusText}${body ? ': ' + truncate(body) : ''}`,
    );
    error.status = response.status;
    error.wwwAuthenticate = response.headers.get('www-authenticate') ?? undefined;
    return error;
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.closed) {
      throw new TransportError('Transport is closed');
    }

    const body = JSON.stringify(message);
    let headers = await this.buildHeaders();
    let response = await this.request({ method: 'POST', body }, headers);

    // At most one retry, and only when the auth layer says it changed something.
    if (response.status === 401 && this.options.onUnauthorized) {
      const error = await this.httpError(response);
      const retry = await this.options
        .onUnauthorized({ error, authorization: headers.authorization })
        .catch(() => false);
      if (!retry) {
        throw error;
      }
      headers = await this.buildHeaders();
      response = await this.request({ method: 'POST', body }, headers);
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
      const error = await this.httpError(response);
      if (response.status === 401) {
        error.message += ' (the server rejected the credential)';
      } else if (response.status === 405 || response.status === 415) {
        error.message += ' (this does not look like a Streamable HTTP MCP endpoint)';
      }
      throw error;
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
      this.onError?.(
        new TransportError(
          `Unexpected content-type "${contentType}" - this does not look like a Streamable HTTP MCP endpoint`,
        ),
      );
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
      const response = await this.request({ method: 'GET' }, headers);
      if (response.status === 405 || response.status === 501) {
        await response.body?.cancel().catch(() => undefined);
        return;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
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
        const response = await this.request({ method: 'DELETE' }, headers);
        await response.body?.cancel().catch(() => undefined);
      } catch {
        // Best effort: the session will time out server-side anyway. A sign-out
        // that already removed the token lands here too, and that is fine.
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
