/**
 * OAuth 2.1 for MCP servers: the authorization-code + PKCE flow the MCP
 * authorization spec is built on.
 *
 * The chain a server can put us through is longer than it looks. A call comes
 * back 401 with a `WWW-Authenticate` header naming its protected-resource
 * metadata (RFC 9728); that metadata names an authorization server; the
 * authorization server's own metadata (RFC 8414) names the endpoints; and if we
 * have no client id for it yet, it may let us register on the spot (RFC 7591).
 * Only then can a browser be opened.
 *
 * Everything in this file is pure protocol - discovery, URL construction, token
 * exchange. Opening a browser, catching the redirect and storing the result
 * belong to the host, because core never imports vscode. That split is also what
 * makes the whole flow testable against a stub fetch.
 */

import { createHash, randomBytes } from 'node:crypto';

/** Grace period: refresh a token slightly before it actually expires. */
const EXPIRY_SKEW_MS = 30_000;

export interface OAuthContext {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function fetchFrom(context: OAuthContext | undefined): typeof fetch {
  const impl = context?.fetchImpl ?? globalThis.fetch;
  if (!impl) {
    throw new OAuthError('global fetch is unavailable; Node 18+ is required');
  }
  return impl;
}

export class OAuthError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = 'OAuthError';
  }
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A fresh verifier/challenge pair. The verifier never leaves the machine until
 * the token exchange, which is the entire point: an intercepted authorization
 * code is useless without it.
 */
export function createPkce(): PkcePair {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

/** Opaque value echoed back on the redirect, to tie it to the request we made. */
export function createState(): string {
  return base64url(randomBytes(16));
}

// ---------------------------------------------------------------------------
// WWW-Authenticate
// ---------------------------------------------------------------------------

export interface WwwAuthenticateChallenge {
  scheme: string;
  /** Where the protected-resource metadata lives, when the server says. */
  resourceMetadata?: string;
  error?: string;
  errorDescription?: string;
  scope?: string;
}

/**
 * Parses the header a 401 carries. Parameters are comma-separated `key="value"`
 * pairs, but servers are inconsistent about quoting, so both forms are accepted.
 */
export function parseWwwAuthenticate(header: string): WwwAuthenticateChallenge {
  const trimmed = header.trim();
  const space = trimmed.indexOf(' ');
  const scheme = space === -1 ? trimmed : trimmed.slice(0, space);
  const rest = space === -1 ? '' : trimmed.slice(space + 1);

  const challenge: WwwAuthenticateChallenge = { scheme };
  const pattern = /([a-zA-Z_-]+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g;
  for (const match of rest.matchAll(pattern)) {
    const key = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? '';
    if (key === 'resource_metadata') challenge.resourceMetadata = value;
    else if (key === 'error') challenge.error = value;
    else if (key === 'error_description') challenge.errorDescription = value;
    else if (key === 'scope') challenge.scope = value;
  }
  return challenge;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface ProtectedResourceMetadata {
  resource?: string;
  authorizationServers: string[];
  scopesSupported?: string[];
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
  codeChallengeMethodsSupported?: string[];
}

/**
 * `.well-known` goes between the host and the path, not at the end - so the
 * metadata for `https://host/mcp/v1` lives at
 * `https://host/.well-known/<name>/mcp/v1`. The path-less form is the fallback,
 * because plenty of servers only publish that one.
 */
export function wellKnownUrls(target: string, name: string): string[] {
  const url = new URL(target);
  const path = url.pathname.replace(/\/+$/, '');
  const candidates = [`${url.origin}/.well-known/${name}${path}`, `${url.origin}/.well-known/${name}`];
  return [...new Set(candidates)];
}

async function fetchJson(url: string, context: OAuthContext | undefined): Promise<unknown> {
  const response = await fetchFrom(context)(url, {
    headers: { accept: 'application/json', 'mcp-protocol-version': '2025-06-18' },
  });
  if (!response.ok) {
    throw new OAuthError(`GET ${url} returned HTTP ${response.status}`);
  }
  return response.json();
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : undefined;
}

/**
 * Protected-resource metadata, either at the URL the 401 named or at the
 * well-known locations derived from the server URL.
 */
export async function discoverProtectedResource(
  serverUrl: string,
  options: { metadataUrl?: string } & OAuthContext = {},
): Promise<ProtectedResourceMetadata> {
  const candidates = options.metadataUrl
    ? [options.metadataUrl]
    : wellKnownUrls(serverUrl, 'oauth-protected-resource');

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const body = (await fetchJson(candidate, options)) as Record<string, unknown>;
      const servers = asStringArray(body.authorization_servers) ?? [];
      if (servers.length === 0) {
        throw new OAuthError(`${candidate} lists no authorization_servers`);
      }
      return {
        resource: typeof body.resource === 'string' ? body.resource : undefined,
        authorizationServers: servers,
        scopesSupported: asStringArray(body.scopes_supported),
      };
    } catch (err) {
      lastError = err;
    }
  }
  throw new OAuthError(
    `No protected-resource metadata for ${serverUrl}: ${errorText(lastError)}`,
    lastError,
  );
}

/**
 * Authorization server metadata. OAuth's well-known comes first, OpenID's
 * second - some issuers only publish the latter.
 */
export async function discoverAuthorizationServer(
  issuer: string,
  context: OAuthContext = {},
): Promise<AuthorizationServerMetadata> {
  const candidates = [
    ...wellKnownUrls(issuer, 'oauth-authorization-server'),
    ...wellKnownUrls(issuer, 'openid-configuration'),
  ];

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const body = (await fetchJson(candidate, context)) as Record<string, unknown>;
      const authorizationEndpoint = body.authorization_endpoint;
      const tokenEndpoint = body.token_endpoint;
      if (typeof authorizationEndpoint !== 'string' || typeof tokenEndpoint !== 'string') {
        throw new OAuthError(`${candidate} is missing authorization_endpoint or token_endpoint`);
      }
      return {
        issuer: typeof body.issuer === 'string' ? body.issuer : issuer,
        authorizationEndpoint,
        tokenEndpoint,
        registrationEndpoint:
          typeof body.registration_endpoint === 'string' ? body.registration_endpoint : undefined,
        scopesSupported: asStringArray(body.scopes_supported),
        codeChallengeMethodsSupported: asStringArray(body.code_challenge_methods_supported),
      };
    } catch (err) {
      lastError = err;
    }
  }
  throw new OAuthError(
    `No authorization-server metadata for ${issuer}: ${errorText(lastError)}`,
    lastError,
  );
}

// ---------------------------------------------------------------------------
// Dynamic client registration
// ---------------------------------------------------------------------------

export interface ClientRegistration {
  clientId: string;
  clientSecret?: string;
  /** Epoch ms after which the registration must be renewed, when given. */
  clientSecretExpiresAt?: number;
}

/**
 * Registers as a public native client. No client secret is requested: the app
 * runs on the user's machine, where a secret could not be kept, and PKCE is what
 * actually protects the exchange.
 */
export async function registerClient(
  registrationEndpoint: string,
  options: { clientName: string; redirectUri: string; scope?: string } & OAuthContext,
): Promise<ClientRegistration> {
  const response = await fetchFrom(options)(registrationEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: options.clientName,
      redirect_uris: [options.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'native',
      ...(options.scope ? { scope: options.scope } : {}),
    }),
  });

  if (!response.ok) {
    throw new OAuthError(
      `Client registration failed: HTTP ${response.status} ${await safeText(response)}`,
    );
  }

  const body = (await response.json()) as Record<string, unknown>;
  if (typeof body.client_id !== 'string') {
    throw new OAuthError('Client registration returned no client_id');
  }
  return {
    clientId: body.client_id,
    clientSecret: typeof body.client_secret === 'string' ? body.client_secret : undefined,
    clientSecretExpiresAt:
      typeof body.client_secret_expires_at === 'number' && body.client_secret_expires_at > 0
        ? body.client_secret_expires_at * 1000
        : undefined,
  };
}

// ---------------------------------------------------------------------------
// Authorization + token exchange
// ---------------------------------------------------------------------------

export interface AuthorizationRequest {
  metadata: AuthorizationServerMetadata;
  clientId: string;
  redirectUri: string;
  pkce: PkcePair;
  state: string;
  scope?: string;
  /** RFC 8707 resource indicator: which MCP server the token is meant for. */
  resource?: string;
}

/** The URL to open in a browser. */
export function buildAuthorizationUrl(request: AuthorizationRequest): string {
  const url = new URL(request.metadata.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', request.clientId);
  url.searchParams.set('redirect_uri', request.redirectUri);
  url.searchParams.set('code_challenge', request.pkce.challenge);
  url.searchParams.set('code_challenge_method', request.pkce.method);
  url.searchParams.set('state', request.state);
  if (request.scope) url.searchParams.set('scope', request.scope);
  // Without this, an authorization server that serves several MCP servers can
  // hand back a token valid for the wrong one.
  if (request.resource) url.searchParams.set('resource', request.resource);
  return url.toString();
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms, or undefined when the server did not say. */
  expiresAt?: number;
  scope?: string;
  tokenType: string;
}

function toTokenSet(body: Record<string, unknown>, now: number, previous?: TokenSet): TokenSet {
  if (typeof body.access_token !== 'string') {
    throw new OAuthError('Token response contained no access_token');
  }
  return {
    accessToken: body.access_token,
    // A refresh response may omit the refresh token, which means keep the old one.
    refreshToken:
      typeof body.refresh_token === 'string' ? body.refresh_token : previous?.refreshToken,
    expiresAt:
      typeof body.expires_in === 'number' ? now + body.expires_in * 1000 : previous?.expiresAt,
    scope: typeof body.scope === 'string' ? body.scope : previous?.scope,
    tokenType: typeof body.token_type === 'string' ? body.token_type : 'Bearer',
  };
}

async function postForm(
  endpoint: string,
  form: Record<string, string | undefined>,
  context: OAuthContext | undefined,
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(form)) {
    if (value !== undefined) body.set(key, value);
  }

  const response = await fetchFrom(context)(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
  });

  const text = await safeText(response);
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // fall through to the status check, which gives a better message
  }

  if (!response.ok) {
    const detail =
      typeof parsed.error_description === 'string'
        ? parsed.error_description
        : typeof parsed.error === 'string'
          ? parsed.error
          : text;
    throw new OAuthError(`Token endpoint returned HTTP ${response.status}: ${truncate(detail)}`);
  }
  return parsed;
}

export async function exchangeAuthorizationCode(
  options: {
    metadata: AuthorizationServerMetadata;
    code: string;
    clientId: string;
    clientSecret?: string;
    redirectUri: string;
    codeVerifier: string;
    resource?: string;
  } & OAuthContext,
): Promise<TokenSet> {
  const body = await postForm(
    options.metadata.tokenEndpoint,
    {
      grant_type: 'authorization_code',
      code: options.code,
      redirect_uri: options.redirectUri,
      client_id: options.clientId,
      client_secret: options.clientSecret,
      code_verifier: options.codeVerifier,
      resource: options.resource,
    },
    options,
  );
  return toTokenSet(body, options.now ? options.now() : Date.now());
}

export async function refreshAccessToken(
  options: {
    metadata: AuthorizationServerMetadata;
    tokens: TokenSet;
    clientId: string;
    clientSecret?: string;
    resource?: string;
  } & OAuthContext,
): Promise<TokenSet> {
  if (!options.tokens.refreshToken) {
    throw new OAuthError('No refresh token; the user has to sign in again');
  }
  const body = await postForm(
    options.metadata.tokenEndpoint,
    {
      grant_type: 'refresh_token',
      refresh_token: options.tokens.refreshToken,
      client_id: options.clientId,
      client_secret: options.clientSecret,
      resource: options.resource,
    },
    options,
  );
  return toTokenSet(body, options.now ? options.now() : Date.now(), options.tokens);
}

/**
 * True when the token is gone or close enough to expiry to be worth replacing.
 * A token with no stated expiry is taken at face value until a 401 says otherwise.
 */
export function needsRefresh(tokens: TokenSet | undefined, now = Date.now()): boolean {
  if (!tokens) return true;
  if (tokens.expiresAt === undefined) return false;
  return tokens.expiresAt - EXPIRY_SKEW_MS <= now;
}

// ---------------------------------------------------------------------------

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncate(value: string, max = 200): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
