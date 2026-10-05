/**
 * A mock authorization server and an OAuth-protected MCP server, both real HTTP
 * listeners on 127.0.0.1, for driving the full sign-in flow under test.
 *
 * They behave like the real thing where it matters: the authorization server
 * verifies PKCE (S256 of the verifier must equal the challenge), checks the
 * redirect URI at both ends, rotates refresh tokens and issues JWT-shaped
 * tokens with real iss/aud/exp claims; the MCP server rejects anything but a
 * live token issued for its own resource, with a proper WWW-Authenticate
 * challenge naming its protected-resource metadata.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function jwt(claims: Record<string, unknown>): string {
  return `${base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${base64url(JSON.stringify(claims))}.mock`;
}

function token(prefix: string): string {
  return `${prefix}-${randomBytes(12).toString('hex')}`;
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

export interface IssuedAccessToken {
  token: string;
  audience: string;
  expiresAt: number;
  scope: string;
  revoked: boolean;
}

export interface MockAuthServerOptions {
  clientId: string;
  /** Path appended to the origin to form the issuer, e.g. "/tenant-1/v2.0". */
  issuerPath?: string;
  /**
   * How /authorize answers: approve, deny (access_denied), reject-redirect (an
   * error page and no redirect, as real identity providers do), or wrong-iss
   * (approve but claim another issuer in the response).
   */
  mode?: 'approve' | 'deny' | 'reject-redirect' | 'wrong-iss' | 'resource-unsupported';
  /** Scopes actually granted, given those requested. */
  grantScopes?: (requested: string[]) => string[];
  accessTokenTtlSeconds?: number;
  rejectRefresh?: boolean;
  /** Token endpoint reports a redirect_uri mismatch. */
  tokenRedirectMismatch?: boolean;
  advertiseS256?: boolean;
  issParameter?: boolean;
  /** Audience to issue when no resource parameter is sent. */
  defaultAudience?: string;
  /** Serve metadata only at the OIDC appended form, like many enterprise IdPs. */
  oidcSuffixOnly?: boolean;
  /** Override the issuer the metadata document declares (mix-up simulation). */
  declaredIssuer?: string;
}

export class MockAuthServer {
  origin = '';
  issuer = '';
  readonly codes = new Map<
    string,
    { clientId: string; redirectUri: string; challenge: string; scope: string[]; resource?: string; nonce?: string; used: boolean }
  >();
  readonly refreshTokens = new Map<string, { scope: string[]; resource?: string; revoked: boolean }>();
  readonly accessTokens = new Map<string, IssuedAccessToken>();
  readonly authorizeRequests: URLSearchParams[] = [];
  readonly tokenRequests: URLSearchParams[] = [];
  readonly issuedSecrets: string[] = [];
  private server?: Server;

  constructor(readonly options: MockAuthServerOptions) {}

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.origin = await listen(this.server);
    this.issuer = `${this.origin}${this.options.issuerPath ?? ''}`;
    return this;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
      this.server?.closeAllConnections?.();
    });
  }

  metadata(): Record<string, unknown> {
    return {
      issuer: this.options.declaredIssuer ?? this.issuer,
      authorization_endpoint: `${this.origin}/authorize`,
      token_endpoint: `${this.origin}/token`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      ...(this.options.advertiseS256 === false ? {} : { code_challenge_methods_supported: ['S256'] }),
      ...(this.options.issParameter === false ? {} : { authorization_response_iss_parameter_supported: true }),
    };
  }

  private metadataPaths(): string[] {
    const path = this.options.issuerPath ?? '';
    if (this.options.oidcSuffixOnly) return [`${path}/.well-known/openid-configuration`];
    return path
      ? [`/.well-known/oauth-authorization-server${path}`]
      : ['/.well-known/oauth-authorization-server'];
  }

  /** Simulates the browser following the authorization URL; returns where it was sent. */
  async browse(authorizationUrl: string): Promise<{ status: number; location?: string }> {
    const response = await fetch(authorizationUrl, { redirect: 'manual' });
    await response.body?.cancel().catch(() => undefined);
    return { status: response.status, location: response.headers.get('location') ?? undefined };
  }

  revokeAll(): void {
    for (const entry of this.accessTokens.values()) entry.revoked = true;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.origin);
    if (req.method === 'GET' && this.metadataPaths().includes(url.pathname)) {
      json(res, 200, this.metadata());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/authorize') {
      this.authorize(url.searchParams, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      await this.token(new URLSearchParams(await readBody(req)), res);
      return;
    }
    res.writeHead(404).end();
  }

  private authorize(params: URLSearchParams, res: ServerResponse): void {
    this.authorizeRequests.push(params);
    const redirectUri = params.get('redirect_uri') ?? '';
    const state = params.get('state') ?? '';
    const mode = this.options.mode ?? 'approve';

    if (params.get('client_id') !== this.options.clientId || mode === 'reject-redirect') {
      // Real identity providers never redirect to an unvalidated redirect URI.
      res.writeHead(400, { 'content-type': 'text/html' }).end('<h1>invalid redirect_uri</h1>');
      return;
    }
    if (params.get('response_type') !== 'code' || params.get('code_challenge_method') !== 'S256') {
      res.writeHead(400).end('bad request');
      return;
    }

    const location = new URL(redirectUri);
    location.searchParams.set('state', state);
    if (mode === 'deny') {
      location.searchParams.set('error', 'access_denied');
      location.searchParams.set('error_description', 'The user cancelled the sign-in');
    } else if (mode === 'resource-unsupported' && params.has('resource')) {
      location.searchParams.set('error', 'invalid_request');
      location.searchParams.set('error_description', "AADSTS901002: The 'resource' request parameter is not supported.");
    } else {
      const code = token('code');
      this.issuedSecrets.push(code);
      this.codes.set(code, {
        clientId: params.get('client_id')!,
        redirectUri,
        challenge: params.get('code_challenge')!,
        scope: (params.get('scope') ?? '').split(' ').filter(Boolean),
        resource: params.get('resource') ?? undefined,
        nonce: params.get('nonce') ?? undefined,
        used: false,
      });
      location.searchParams.set('code', code);
    }
    if (this.options.issParameter !== false) {
      location.searchParams.set('iss', mode === 'wrong-iss' ? 'https://evil.example.com' : this.issuer);
    }
    res.writeHead(302, { location: location.toString() }).end();
  }

  private issueTokens(scope: string[], resource: string | undefined, nonce: string | undefined, clientId: string) {
    const granted = this.options.grantScopes ? this.options.grantScopes(scope) : scope;
    const ttl = this.options.accessTokenTtlSeconds ?? 3600;
    const now = Math.floor(Date.now() / 1000);
    const audience = resource ?? this.options.defaultAudience ?? 'api://mock-api';
    const accessToken = jwt({
      iss: this.issuer,
      aud: audience,
      sub: 'user-1',
      exp: now + ttl,
      iat: now,
      scp: granted.join(' '),
      preferred_username: 'ada@example.test',
      jti: randomBytes(8).toString('hex'),
    });
    const refreshToken = token('refresh');
    this.issuedSecrets.push(accessToken, refreshToken);
    this.accessTokens.set(accessToken, {
      token: accessToken,
      audience,
      expiresAt: (now + ttl) * 1000,
      scope: granted.join(' '),
      revoked: false,
    });
    this.refreshTokens.set(refreshToken, { scope, resource, revoked: false });
    const body: Record<string, unknown> = {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ttl,
      refresh_token: refreshToken,
      scope: granted.join(' '),
    };
    if (scope.includes('openid')) {
      body.id_token = jwt({
        iss: this.issuer,
        aud: clientId,
        sub: 'user-1',
        nonce,
        exp: now + ttl,
        iat: now,
        preferred_username: 'ada@example.test',
      });
      this.issuedSecrets.push(body.id_token as string);
    }
    return body;
  }

  private async token(params: URLSearchParams, res: ServerResponse): Promise<void> {
    this.tokenRequests.push(params);
    const grant = params.get('grant_type');

    if (grant === 'authorization_code') {
      const entry = this.codes.get(params.get('code') ?? '');
      if (!entry || entry.used) {
        json(res, 400, { error: 'invalid_grant', error_description: 'unknown or used code' });
        return;
      }
      entry.used = true;
      if (this.options.tokenRedirectMismatch || params.get('redirect_uri') !== entry.redirectUri) {
        json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri does not match the authorization request' });
        return;
      }
      if (params.get('client_id') !== entry.clientId) {
        json(res, 400, { error: 'invalid_client' });
        return;
      }
      const challenge = base64url(createHash('sha256').update(params.get('code_verifier') ?? '').digest());
      if (challenge !== entry.challenge) {
        json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        return;
      }
      json(res, 200, this.issueTokens(entry.scope, entry.resource, entry.nonce, entry.clientId));
      return;
    }

    if (grant === 'refresh_token') {
      const entry = this.refreshTokens.get(params.get('refresh_token') ?? '');
      if (this.options.rejectRefresh || !entry || entry.revoked) {
        json(res, 400, { error: 'invalid_grant', error_description: 'refresh token revoked' });
        return;
      }
      // Rotation: a refresh token works exactly once.
      entry.revoked = true;
      json(res, 200, this.issueTokens(entry.scope, entry.resource, undefined, params.get('client_id') ?? ''));
      return;
    }

    json(res, 400, { error: 'unsupported_grant_type' });
  }
}

export interface MockToolDef {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export interface MockMcpServerOptions {
  auth: MockAuthServer;
  tools?: MockToolDef[];
  pageSize?: number;
  failToolsList?: boolean;
  /** How the 401 challenge looks. */
  challenge?: 'full' | 'no-header' | 'no-metadata' | 'foreign-metadata';
  foreignMetadataUrl?: string;
  /** Authorization servers listed in protected-resource metadata. */
  authorizationServers?: string[];
  /** The `resource` its metadata declares; defaults to its own URL. */
  declaredResource?: string;
  /** Audiences accepted besides its own URL. */
  acceptedAudiences?: string[];
  /** Set false to publish no protected-resource metadata at all. */
  servePrm?: boolean;
}

export class MockMcpServer {
  origin = '';
  url = '';
  readonly authorizations: string[] = [];
  readonly methods: string[] = [];
  unauthorizedCount = 0;
  private server?: Server;

  constructor(readonly options: MockMcpServerOptions) {}

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    this.origin = await listen(this.server);
    this.url = `${this.origin}/mcp`;
    return this;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
      this.server?.closeAllConnections?.();
    });
  }

  private challengeHeader(): string | undefined {
    switch (this.options.challenge ?? 'full') {
      case 'no-header':
        return undefined;
      case 'no-metadata':
        return 'Bearer realm="mcp"';
      case 'foreign-metadata':
        return `Bearer resource_metadata="${this.options.foreignMetadataUrl}"`;
      default:
        return `Bearer resource_metadata="${this.origin}/.well-known/oauth-protected-resource/mcp", scope="mcp:read"`;
    }
  }

  private authorized(header: string | undefined): boolean {
    if (!header?.startsWith('Bearer ')) return false;
    const issued = this.options.auth.accessTokens.get(header.slice(7));
    if (!issued || issued.revoked || issued.expiresAt <= Date.now()) return false;
    const accepted = [this.url, ...(this.options.acceptedAudiences ?? [])];
    return accepted.includes(issued.audience);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.origin);
    if (
      req.method === 'GET' &&
      url.pathname === '/.well-known/oauth-protected-resource/mcp' &&
      this.options.servePrm !== false
    ) {
      json(res, 200, {
        resource: this.options.declaredResource ?? this.url,
        authorization_servers: this.options.authorizationServers ?? [this.options.auth.issuer],
        scopes_supported: ['mcp:read', 'mcp:write'],
      });
      return;
    }
    if (url.pathname !== '/mcp') {
      res.writeHead(404).end();
      return;
    }

    const authorization = req.headers.authorization;
    if (authorization) this.authorizations.push(authorization);
    if (!this.authorized(authorization)) {
      this.unauthorizedCount++;
      const challenge = this.challengeHeader();
      res.writeHead(401, challenge ? { 'www-authenticate': challenge, 'content-type': 'application/json' } : { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      await readBody(req).catch(() => undefined);
      return;
    }

    if (req.method === 'GET') {
      res.writeHead(405).end();
      return;
    }
    if (req.method === 'DELETE') {
      res.writeHead(204).end();
      return;
    }

    const message = JSON.parse(await readBody(req)) as {
      id?: number | string;
      method: string;
      params?: { cursor?: string };
    };
    this.methods.push(message.method);

    if (message.id === undefined) {
      res.writeHead(202).end();
      return;
    }

    const reply = (result: unknown) =>
      json(res, 200, { jsonrpc: '2.0', id: message.id, result }, { 'mcp-session-id': 'mock-session' });

    switch (message.method) {
      case 'initialize':
        reply({
          protocolVersion: '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'mock-protected-mcp', version: '1.0.0' },
        });
        return;
      case 'ping':
        reply({});
        return;
      case 'tools/list': {
        if (this.options.failToolsList) {
          json(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'tool registry unavailable' } });
          return;
        }
        const tools = this.options.tools ?? [];
        const size = this.options.pageSize ?? (tools.length || 1);
        const start = Number(message.params?.cursor ?? 0);
        const page = tools.slice(start, start + size);
        const next = start + size < tools.length ? String(start + size) : undefined;
        reply(next ? { tools: page, nextCursor: next } : { tools: page });
        return;
      }
      default:
        json(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } });
    }
  }
}

/** In-memory stand-ins for SecretStorage and globalState. */
export class MemorySecrets {
  readonly values = new Map<string, string>();
  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }
  async store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

export class MemoryState {
  readonly values = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}
