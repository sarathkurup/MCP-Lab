/**
 * Receiving the browser's return trip.
 *
 * Two ways back exist - the editor's URI handler (vscode://…) and a loopback
 * listener on 127.0.0.1 - and both deliver into one registry of pending
 * authorizations, so state validation lives in exactly one place:
 *
 *   - state is compared in constant time against every pending request
 *   - a state is consumed once; a replay of the same redirect is reported as a
 *     duplicate and ignored
 *   - an expired request is failed rather than completed late
 *   - a redirect whose state matches nothing fails the sign-in it was aimed at
 *     instead of being silently dropped, so a forged or stale callback is
 *     visible rather than leaving the user waiting
 *
 * Nothing here logs the query string: it carries the authorization code.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OAuthError, fingerprint, parseCallbackParams, secretsEqual, type CallbackParams } from './oauth';

/** The fixed path the editor URI handler and the loopback listener both answer on. */
export const CALLBACK_PATH = '/auth/callback';

/** How long a consumed state is remembered, to recognise replays. */
const CONSUMED_TTL_MS = 15 * 60_000;

export type DeliveryOutcome =
  | 'accepted'
  | 'no-pending'
  | 'wrong-path'
  | 'missing-state'
  | 'state-mismatch'
  | 'duplicate'
  | 'expired';

interface PendingEntry {
  flowId: string;
  projectId: string;
  state: string;
  callbackPath: string;
  expiresAt: number;
  resolve: (params: CallbackParams) => void;
  reject: (error: OAuthError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface PendingHandle {
  /** Settles with the callback parameters, which may describe an error. */
  result: Promise<CallbackParams>;
  cancel(error: OAuthError): void;
}

function normalizePath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

export class PendingAuthorizations {
  private readonly entries = new Map<string, PendingEntry>();
  private readonly consumed = new Map<string, number>();
  private counter = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Registers a sign-in that is waiting for its redirect. A newer sign-in for
   * the same project supersedes an older one, so two browser tabs racing each
   * other cannot both complete.
   */
  begin(options: {
    projectId: string;
    state: string;
    callbackPath: string;
    timeoutMs: number;
  }): PendingHandle {
    for (const entry of [...this.entries.values()]) {
      if (entry.projectId === options.projectId) {
        this.settle(entry).reject(
          new OAuthError('Superseded by a newer sign-in for the same project', undefined, 'login_cancelled'),
        );
      }
    }

    const flowId = `flow-${++this.counter}`;
    let resolve!: (params: CallbackParams) => void;
    let reject!: (error: OAuthError) => void;
    const result = new Promise<CallbackParams>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Callers that cancel before awaiting must not trigger an unhandled rejection.
    result.catch(() => undefined);

    const timer = setTimeout(() => {
      const entry = this.entries.get(flowId);
      if (entry) {
        this.settle(entry).reject(
          new OAuthError(
            `Timed out after ${Math.round(options.timeoutMs / 1000)}s waiting for the browser to return`,
            undefined,
            'timeout',
            'If the browser showed an error about the redirect URI, register the redirect URI shown in "MCP Lab: Auth" with the identity provider.',
          ),
        );
      }
    }, options.timeoutMs);
    timer.unref?.();

    const entry: PendingEntry = {
      flowId,
      projectId: options.projectId,
      state: options.state,
      callbackPath: normalizePath(options.callbackPath),
      expiresAt: this.now() + options.timeoutMs,
      resolve,
      reject,
      timer,
    };
    this.entries.set(flowId, entry);

    return {
      result,
      cancel: (error) => {
        const current = this.entries.get(flowId);
        if (current) this.settle(current).reject(error);
      },
    };
  }

  /** Removes an entry and stops its timer, returning its settle functions. */
  private settle(entry: PendingEntry): PendingEntry {
    clearTimeout(entry.timer);
    this.entries.delete(entry.flowId);
    return entry;
  }

  hasPending(projectId?: string): boolean {
    return [...this.entries.values()].some((entry) => !projectId || entry.projectId === projectId);
  }

  cancelProject(projectId: string, error: OAuthError): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.projectId === projectId) this.settle(entry).reject(error);
    }
  }

  /** Hands a redirect to whichever sign-in it belongs to. */
  deliver(path: string, query: URLSearchParams | string): DeliveryOutcome {
    this.prune();
    const params = parseCallbackParams(query);
    const candidates = [...this.entries.values()].filter(
      (entry) => entry.callbackPath === normalizePath(path),
    );

    if (this.entries.size === 0) {
      return params.state && this.consumed.has(fingerprint(params.state, 32)) ? 'duplicate' : 'no-pending';
    }
    if (candidates.length === 0) return 'wrong-path';

    if (!params.state) {
      if (candidates.length === 1) {
        this.settle(candidates[0]).reject(
          new OAuthError('The sign-in response carried no state', undefined, 'state_mismatch'),
        );
      }
      return 'missing-state';
    }

    // Every candidate is compared, so timing says nothing about which matched.
    let match: PendingEntry | undefined;
    for (const entry of candidates) {
      if (secretsEqual(entry.state, params.state)) match = entry;
    }

    if (!match) {
      if (this.consumed.has(fingerprint(params.state, 32))) return 'duplicate';
      if (candidates.length === 1) {
        this.settle(candidates[0]).reject(
          new OAuthError(
            'The sign-in response does not belong to this sign-in (state mismatch)',
            undefined,
            'state_mismatch',
            'Start the sign-in again. If it keeps happening, another tab or application may be completing sign-ins for you.',
          ),
        );
      }
      return 'state-mismatch';
    }

    if (match.expiresAt <= this.now()) {
      this.settle(match).reject(
        new OAuthError('The sign-in response arrived after the request expired', undefined, 'timeout'),
      );
      return 'expired';
    }

    this.settle(match);
    this.consumed.set(fingerprint(params.state, 32), this.now() + CONSUMED_TTL_MS);
    match.resolve(params);
    return 'accepted';
  }

  private prune(): void {
    const now = this.now();
    for (const [key, expiry] of this.consumed) {
      if (expiry <= now) this.consumed.delete(key);
    }
  }

  dispose(): void {
    for (const entry of [...this.entries.values()]) {
      this.settle(entry).reject(new OAuthError('Sign-in was interrupted', undefined, 'login_cancelled'));
    }
    this.consumed.clear();
  }
}

// ---------------------------------------------------------------------------
// Loopback listener
// ---------------------------------------------------------------------------

export interface LoopbackReceiver {
  /** `http://127.0.0.1:<port><path>`, with the port the OS actually assigned. */
  redirectUri: string;
  port: number;
  close(): Promise<void>;
}

const PAGES: Record<'done' | 'failed' | 'duplicate' | 'rejected' | 'not-found', { status: number; title: string; body: string }> = {
  done: {
    status: 200,
    title: 'Signed in',
    body: 'Authentication is complete. You can close this tab and return to VS Code.',
  },
  failed: {
    status: 200,
    title: 'Sign-in did not complete',
    body: 'The identity provider reported a problem. Return to VS Code for the details.',
  },
  duplicate: {
    status: 409,
    title: 'Already handled',
    body: 'This sign-in response was already used. Return to VS Code.',
  },
  rejected: {
    status: 400,
    title: 'Sign-in rejected',
    body: 'This response does not match the sign-in VS Code started, so it was not accepted.',
  },
  'not-found': { status: 404, title: 'Not found', body: 'Nothing is served here.' },
};

/**
 * A static page. Nothing from the request is echoed into it, so the query
 * string - which holds the code - cannot be reflected into markup, and the
 * page loads nothing that could leak it through a Referer header.
 */
function respond(res: ServerResponse, page: keyof typeof PAGES): void {
  const { status, title, body } = PAGES[page];
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    connection: 'close',
  });
  res.end(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
      '<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;line-height:1.5}</style>' +
      `</head><body><h1>${title}</h1><p>${body}</p></body></html>`,
  );
}

/**
 * Listens on 127.0.0.1 only - never 0.0.0.0 - on the port asked for, or one the
 * OS picks. Accepts a single matching callback, then stops listening.
 */
export async function startLoopbackReceiver(options: {
  registry: PendingAuthorizations;
  path?: string;
  /** 0 or undefined lets the OS choose a free port. */
  port?: number;
}): Promise<LoopbackReceiver> {
  const path = normalizePath(options.path ?? CALLBACK_PATH);
  let closed = false;
  let server: Server | undefined;

  const close = (): Promise<void> =>
    new Promise((resolve) => {
      if (closed || !server) {
        closed = true;
        resolve();
        return;
      }
      closed = true;
      server.close(() => resolve());
      server.closeAllConnections?.();
    });

  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'GET' || !req.url) {
      respond(res, 'not-found');
      return;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (normalizePath(url.pathname) !== path) {
      respond(res, 'not-found');
      return;
    }
    const outcome = options.registry.deliver(url.pathname, url.searchParams);
    // Stop listening once the page has actually been sent: closing sooner
    // would cut the connection and show the user a reset instead of the page.
    const closeAfterResponse = () => res.once('finish', () => void close());
    switch (outcome) {
      case 'accepted':
        closeAfterResponse();
        respond(res, url.searchParams.has('error') ? 'failed' : 'done');
        return;
      case 'duplicate':
        respond(res, 'duplicate');
        return;
      case 'missing-state':
      case 'state-mismatch':
      case 'expired':
        closeAfterResponse();
        respond(res, 'rejected');
        return;
      default:
        respond(res, 'not-found');
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      reject(
        new OAuthError(
          err.code === 'EADDRINUSE'
            ? `Port ${options.port} on 127.0.0.1 is already in use, so the sign-in callback cannot listen there`
            : `Could not start the sign-in callback listener: ${err.message}`,
          err,
          'invalid_configuration',
          'Leave the port out of MCP_OAUTH_REDIRECT_URI to let the OS pick a free one, if the identity provider allows it.',
        ),
      );
    };
    server!.once('error', onError);
    server!.listen({ host: '127.0.0.1', port: options.port ?? 0, exclusive: true }, () => {
      server!.off('error', onError);
      resolve();
    });
  });

  const port = (server.address() as AddressInfo).port;
  return {
    redirectUri: `http://127.0.0.1:${port}${path}`,
    port,
    close,
  };
}
