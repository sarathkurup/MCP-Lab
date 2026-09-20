/**
 * Authentication strategies for HTTP servers.
 *
 * Only the *shape* of a credential lives here; the secret itself is held by the
 * host (VS Code SecretStorage) and injected through `resolveSecret`. That keeps
 * core free of any storage dependency and means a secret is never written to a
 * settings file, a config object, or a log line.
 */

export type AuthKind = 'none' | 'bearer' | 'header' | 'basic' | 'oauth-client-credentials';

export interface AuthConfig {
  kind: AuthKind;
  /** For `header`: the header name to send, e.g. `x-api-key`. */
  headerName?: string;
  /** For `basic`: the username; the password is the stored secret. */
  username?: string;
  /** For OAuth: where to exchange credentials for a token. */
  tokenUrl?: string;
  clientId?: string;
  scope?: string;
  /** Extra static headers. Never put a secret here. */
  headers?: Record<string, string>;
}

export interface TokenCacheEntry {
  accessToken: string;
  expiresAt: number;
}

export interface AuthContext {
  /** Returns the stored secret for this server, or undefined. */
  resolveSecret: () => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Builds the headers for one request. OAuth tokens are cached until shortly
 * before they expire, so a rotated or revoked credential is picked up without
 * restarting the connection.
 */
export class AuthProvider {
  private cached?: TokenCacheEntry;

  constructor(
    private readonly config: AuthConfig,
    private readonly context: AuthContext,
  ) {}

  private get now(): number {
    return this.context.now ? this.context.now() : Date.now();
  }

  async headers(): Promise<Record<string, string>> {
    const base = { ...(this.config.headers ?? {}) };

    switch (this.config.kind) {
      case 'none':
        return base;

      case 'bearer': {
        const secret = await this.context.resolveSecret();
        return secret ? { ...base, authorization: `Bearer ${secret}` } : base;
      }

      case 'header': {
        const secret = await this.context.resolveSecret();
        const name = this.config.headerName?.toLowerCase();
        if (!secret || !name) {
          return base;
        }
        return { ...base, [name]: secret };
      }

      case 'basic': {
        const secret = await this.context.resolveSecret();
        if (!secret || !this.config.username) {
          return base;
        }
        const encoded = base64(`${this.config.username}:${secret}`);
        return { ...base, authorization: `Basic ${encoded}` };
      }

      case 'oauth-client-credentials': {
        const token = await this.accessToken();
        return token ? { ...base, authorization: `Bearer ${token}` } : base;
      }

      default:
        return base;
    }
  }

  /** Forces the next request to mint a fresh token. */
  invalidate(): void {
    this.cached = undefined;
  }

  private async accessToken(): Promise<string | undefined> {
    // Refresh 30s early so a token cannot expire mid-flight.
    if (this.cached && this.cached.expiresAt - 30_000 > this.now) {
      return this.cached.accessToken;
    }

    const { tokenUrl, clientId, scope } = this.config;
    const clientSecret = await this.context.resolveSecret();
    if (!tokenUrl || !clientId || !clientSecret) {
      return undefined;
    }

    const fetchImpl = this.context.fetchImpl ?? globalThis.fetch;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    });
    if (scope) {
      body.set('scope', scope);
    }

    const response = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      throw new Error(
        `Token request failed: HTTP ${response.status} ${response.statusText}`,
      );
    }

    const payload = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!payload.access_token) {
      throw new Error('Token endpoint returned no access_token');
    }

    this.cached = {
      accessToken: payload.access_token,
      expiresAt: this.now + (payload.expires_in ?? 3600) * 1000,
    };
    return this.cached.accessToken;
  }
}

/** Describes an auth config without ever revealing the secret. */
export function describeAuth(config: AuthConfig | undefined): string {
  if (!config || config.kind === 'none') {
    return 'None';
  }
  switch (config.kind) {
    case 'bearer':
      return 'Bearer token';
    case 'header':
      return `Header ${config.headerName ?? '(unset)'}`;
    case 'basic':
      return `Basic (${config.username ?? 'no username'})`;
    case 'oauth-client-credentials':
      return `OAuth client credentials (${config.clientId ?? 'no client id'})`;
    default:
      return config.kind;
  }
}

function base64(value: string): string {
  if (typeof btoa === 'function') {
    return btoa(value);
  }
  // Node path; avoids importing node:buffer into a module the webview may load.
  return (globalThis as { Buffer?: { from(v: string, e: string): { toString(e: string): string } } })
    .Buffer!.from(value, 'utf8')
    .toString('base64');
}
