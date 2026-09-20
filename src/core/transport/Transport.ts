import type { JsonRpcMessage } from '../protocol';

/**
 * A bidirectional MCP message channel. Everything above this interface is
 * transport-agnostic, so adding SSE or a future transport means adding one file.
 */
export interface Transport {
  readonly kind: string;

  /** Establish the channel. Resolves once messages can be sent. */
  start(): Promise<void>;

  send(message: JsonRpcMessage): Promise<void>;

  close(): Promise<void>;

  /** Called for every inbound message. Set before start(). */
  onMessage?: (message: JsonRpcMessage) => void;

  /** Transport-level failure (spawn failed, socket dropped, bad frame). */
  onError?: (error: Error) => void;

  /** The peer went away. */
  onClose?: (reason?: string) => void;

  /** Out-of-band diagnostics, e.g. a child process writing to stderr. */
  onStderr?: (chunk: string) => void;
}

export class TransportError extends Error {
  /** HTTP status, when the failure came from an HTTP response. */
  status?: number;
  /**
   * The raw `WWW-Authenticate` header from a 401. Kept because it is the only
   * place a server says where its authorization metadata lives, and throwing it
   * away would force the OAuth flow to guess.
   */
  wwwAuthenticate?: string;

  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = 'TransportError';
  }
}
