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
 * Everything in this file is pure protocol - discovery, validation, URL
 * construction, token exchange. Opening a browser, catching the redirect and
 * storing the result belong to the host, because core never imports vscode.
 * That split is also what makes the whole flow testable against a stub fetch.
 *
 * Nothing here logs. Functions that see secrets (codes, verifiers, tokens) only
 * ever return them to the caller; deciding what is safe to write down is the
 * session manager's job, and it never writes any of them.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { describeNetworkFailure } from './netErrors';

/** Grace period: refresh a token slightly before it actually expires. */
export const EXPIRY_SKEW_MS = 30_000;

/** Tolerance for clock drift between this machine and an issuer when reading exp/nbf. */
export const CLOCK_SKEW_MS = 120_000;

/** The protocol revision sent on discovery requests, which some servers gate on. */
const DISCOVERY_PROTOCOL_VERSION = '2025-06-18';

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

/**
 * Every failure the flow can report, so the UI can say something specific. The
 * codes are stable identifiers; the message is for people.
 */
export type OAuthErrorCode =
  | 'oauth_error'
  | 'missing_configuration'
  | 'invalid_configuration'
  | 'missing_www_authenticate'
  | 'missing_resource_metadata'
  | 'invalid_resource_metadata'
  | 'resource_mismatch'
  | 'authorization_server_mismatch'
  | 'invalid_authorization_server_metadata'
  | 'untrusted_host'
  | 'pkce_unsupported'
  | 'unsupported_grant'
  | 'dynamic_registration_unsupported'
  | 'redirect_uri_mismatch'
  | 'login_cancelled'
  | 'timeout'
  | 'state_mismatch'
  | 'issuer_mismatch'
  | 'code_exchange_failed'
  | 'invalid_token_response'
  | 'scope_not_granted'
  | 'wrong_issuer'
  | 'wrong_audience'
  | 'token_expired'
  | 'refresh_failed'
  | 'sign_in_required'
  | 'token_host_mismatch'
  | 'unsupported_environment'
  | 'browser_unavailable'
  | 'network_error'
  | 'certificate_error';

export class OAuthError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
    readonly code: OAuthErrorCode = 'oauth_error',
    /** What the user can do about it, when there is something. */
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

/** Finds an OAuthError anywhere in a cause chain, including McpError.data. */
export function findOAuthError(err: unknown, depth = 0): OAuthError | undefined {
  if (!err || depth > 6) return undefined;
  if (err instanceof OAuthError) return err;
  const candidate = err as { cause?: unknown; data?: unknown };
  return findOAuthError(candidate.cause, depth + 1) ?? findOAuthError(candidate.data, depth + 1);
}

// ---------------------------------------------------------------------------
// Randomness, PKCE and constant-time comparison
// ---------------------------------------------------------------------------

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

export function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** BASE64URL(SHA256(verifier)), as RFC 7636 §4.2 defines the S256 challenge. */
export function codeChallengeFor(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

/**
 * A fresh verifier/challenge pair. The verifier never leaves the machine until
 * the token exchange, which is the entire point: an intercepted authorization
 * code is useless without it.
 */
export function createPkce(): PkcePair {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: codeChallengeFor(verifier), method: 'S256' };
}

/** Opaque value echoed back on the redirect, to tie it to the request we made. */
export function createState(): string {
  return base64url(randomBytes(32));
}

/** Binds an OpenID Connect ID token to the request that asked for it. */
export function createNonce(): string {
  return base64url(randomBytes(32));
}

/**
 * Compares two secrets without leaking, through timing, how much of a guess
 * was right. Both sides are hashed first so inputs of different lengths still
 * go through timingSafeEqual rather than short-circuiting on the length.
 */
export function secretsEqual(a: string | undefined, b: string | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right) && a.length === b.length;
}

/** A short, non-reversible fingerprint, for keys and for telling tokens apart in memory. */
export function fingerprint(value: string, length = 16): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

// ---------------------------------------------------------------------------
// WWW-Authenticate
// ---------------------------------------------------------------------------

export interface AuthChallenge {
  scheme: string;
  /** Parameter names lower-cased; values unquoted and unescaped. */
  params: Record<string, string>;
  token68?: string;
}

export interface WwwAuthenticateChallenge {
  scheme: string;
  /** Where the protected-resource metadata lives, when the server says. */
  resourceMetadata?: string;
  error?: string;
  errorDescription?: string;
  scope?: string;
}

const TOKEN_CHAR = /[A-Za-z0-9!#$%&'*+.^_`|~/-]/;

/**
 * Splits a WWW-Authenticate header into its challenges (RFC 9110 §11.6.1).
 *
 * One header can carry several - `Basic realm="x", Bearer resource_metadata="…"`
 * - and the commas that separate challenges are the same commas that separate
 * parameters, so this is a small tokenizer rather than a split. A token that is
 * not followed by `=` starts a new challenge, unless it directly follows a
 * scheme, in which case it is that scheme's token68.
 */
export function parseAuthenticateChallenges(header: string): AuthChallenge[] {
  const challenges: AuthChallenge[] = [];
  let current: AuthChallenge | undefined;
  let commaSinceToken = true;
  let i = 0;
  const n = header.length;

  const skipSpaces = () => {
    while (i < n && (header[i] === ' ' || header[i] === '\t')) i++;
  };

  while (i < n) {
    skipSpaces();
    if (i >= n) break;
    if (header[i] === ',') {
      commaSinceToken = true;
      i++;
      continue;
    }

    const start = i;
    while (i < n && TOKEN_CHAR.test(header[i])) i++;
    const token = header.slice(start, i);
    if (!token) {
      i++; // a character no grammar allows here; skip it rather than loop
      continue;
    }

    skipSpaces();
    if (header[i] === '=' && current && header[i + 1] !== '=') {
      i++;
      skipSpaces();
      let value = '';
      if (header[i] === '"') {
        i++;
        while (i < n && header[i] !== '"') {
          if (header[i] === '\\' && i + 1 < n) {
            value += header[i + 1];
            i += 2;
          } else {
            value += header[i];
            i++;
          }
        }
        i++; // closing quote
      } else {
        const valueStart = i;
        while (i < n && header[i] !== ',' && header[i] !== ' ' && header[i] !== '\t') i++;
        value = header.slice(valueStart, i);
      }
      current.params[token.toLowerCase()] = value;
      commaSinceToken = false;
      continue;
    }

    const isToken68 =
      current !== undefined &&
      !commaSinceToken &&
      current.token68 === undefined &&
      Object.keys(current.params).length === 0;

    if (isToken68) {
      // Swallow padding that the token scan stopped at.
      let padded = token;
      while (header[i] === '=') {
        padded += '=';
        i++;
      }
      current!.token68 = padded;
    } else {
      current = { scheme: token, params: {} };
      challenges.push(current);
    }
    commaSinceToken = false;
  }

  return challenges;
}

/** The Bearer challenge, if the header has one. */
export function findBearerChallenge(header: string | undefined | null): AuthChallenge | undefined {
  if (!header) return undefined;
  return parseAuthenticateChallenges(header).find(
    (challenge) => challenge.scheme.toLowerCase() === 'bearer',
  );
}

/**
 * Parses the header a 401 carries into the fields the flow uses. Prefers the
 * Bearer challenge when the server offers several schemes; servers are
 * inconsistent about quoting, so both forms are accepted.
 */
export function parseWwwAuthenticate(header: string): WwwAuthenticateChallenge {
  const challenges = parseAuthenticateChallenges(header);
  const chosen =
    challenges.find((challenge) => challenge.scheme.toLowerCase() === 'bearer') ?? challenges[0];
  if (!chosen) return { scheme: header.trim() };

  const result: WwwAuthenticateChallenge = { scheme: chosen.scheme };
  const { params } = chosen;
  if (params.resource_metadata !== undefined) result.resourceMetadata = params.resource_metadata;
  if (params.error !== undefined) result.error = params.error;
  if (params.error_description !== undefined) result.errorDescription = params.error_description;
  if (params.scope !== undefined) result.scope = params.scope;
  return result;
}

// ---------------------------------------------------------------------------
// URLs: normalisation and trust
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

export function tryParseUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * HTTPS everywhere, with one exception: plain HTTP to the machine itself, which
 * is what local development servers and the loopback callback use. A token or a
 * code sent over plain HTTP to anywhere else is readable on the network.
 */
export function isSecureUrl(value: string | URL): boolean {
  const url = typeof value === 'string' ? tryParseUrl(value) : value;
  if (!url) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && isLoopbackHost(url.hostname);
}

/**
 * The comparable form of a URL: scheme and host lower-cased, default port
 * dropped, no fragment, no trailing slash. Non-URL identifiers (e.g. `api://…`
 * audiences that `URL` still parses, or plain strings) fall back to a trim.
 */
export function normalizeUrl(value: string): string {
  const url = tryParseUrl(value);
  if (!url) return value.trim().replace(/\/+$/, '');
  url.hash = '';
  const path = url.pathname.replace(/\/+$/, '');
  const port = url.port ? `:${url.port}` : '';
  return `${url.protocol}//${url.hostname.toLowerCase()}${port}${path}${url.search}`;
}

export function sameOrigin(a: string, b: string): boolean {
  const left = tryParseUrl(a);
  const right = tryParseUrl(b);
  return !!left && !!right && left.origin === right.origin;
}

/**
 * Whether metadata for `advertised` covers the resource we are talking to.
 * RFC 9728 asks for an exact match; a parent path on the same origin is also
 * accepted, because servers commonly publish one document for the whole host.
 * Different origins never match.
 */
export function resourceCovers(advertised: string, actual: string): boolean {
  const a = normalizeUrl(advertised);
  const b = normalizeUrl(actual);
  if (a === b) return true;
  if (!sameOrigin(advertised, actual)) return false;
  const aPath = tryParseUrl(advertised)?.pathname.replace(/\/+$/, '') ?? '';
  const bPath = tryParseUrl(actual)?.pathname.replace(/\/+$/, '') ?? '';
  return aPath === '' || bPath === aPath || bPath.startsWith(`${aPath}/`);
}

/**
 * Removes anything secret-shaped from a URL before it is shown or logged:
 * credentials in the authority, every query value, and the fragment.
 */
export function sanitizeUrl(value: string | undefined): string {
  if (!value) return '';
  const url = tryParseUrl(value);
  if (!url) return '(invalid URL)';
  url.username = '';
  url.password = '';
  url.hash = '';
  const keys = [...new Set([...url.searchParams.keys()])];
  if (keys.length === 0) return url.toString();
  url.search = '';
  return `${url.toString()}?${keys.map((key) => `${encodeURIComponent(key)}=***`).join('&')}`;
}

// ---------------------------------------------------------------------------
// Discovery: protected-resource metadata (RFC 9728)
// ---------------------------------------------------------------------------

export interface ProtectedResourceMetadata {
  resource?: string;
  authorizationServers: string[];
  scopesSupported?: string[];
  /** Where this document was read from. */
  metadataUrl?: string;
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
  let response: Response;
  try {
    response = await fetchFrom(context)(url, {
      headers: { accept: 'application/json', 'mcp-protocol-version': DISCOVERY_PROTOCOL_VERSION },
      // Metadata is read from where it was looked for; a redirect elsewhere is
      // exactly the kind of hop the trust checks exist to stop.
      redirect: 'error',
    });
  } catch (err) {
    throw networkError(`GET ${sanitizeUrl(url)}`, err);
  }
  if (!response.ok) {
    throw new OAuthError(`GET ${sanitizeUrl(url)} returned HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch (err) {
    throw new OAuthError(`GET ${sanitizeUrl(url)} did not return JSON`, err);
  }
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : undefined;
}

/** Reads and shape-checks one protected-resource metadata document. */
export async function fetchProtectedResourceMetadata(
  metadataUrl: string,
  context: OAuthContext = {},
): Promise<ProtectedResourceMetadata> {
  const body = (await fetchJson(metadataUrl, context)) as Record<string, unknown>;
  if (!body || typeof body !== 'object') {
    throw new OAuthError(`${sanitizeUrl(metadataUrl)} is not a JSON object`, undefined, 'invalid_resource_metadata');
  }
  const servers = asStringArray(body.authorization_servers) ?? [];
  if (servers.length === 0) {
    throw new OAuthError(
      `${sanitizeUrl(metadataUrl)} lists no authorization_servers`,
      undefined,
      'invalid_resource_metadata',
    );
  }
  return {
    resource: typeof body.resource === 'string' ? body.resource : undefined,
    authorizationServers: servers,
    scopesSupported: asStringArray(body.scopes_supported),
    metadataUrl,
  };
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
      return await fetchProtectedResourceMetadata(candidate, options);
    } catch (err) {
      lastError = err;
    }
  }
  throw new OAuthError(
    `No protected-resource metadata for ${sanitizeUrl(serverUrl)}: ${errorText(lastError)}`,
    lastError,
    'missing_resource_metadata',
  );
}

/**
 * Checks that a metadata document really describes the resource we are about
 * to authenticate for. RFC 9728 §3.3 makes `resource` required precisely so a
 * client can catch metadata served for some other resource.
 */
export function validateProtectedResourceMetadata(
  metadata: ProtectedResourceMetadata,
  expectedResource: string,
): void {
  if (!metadata.resource) {
    throw new OAuthError(
      `Protected-resource metadata at ${sanitizeUrl(metadata.metadataUrl)} has no "resource" field`,
      undefined,
      'invalid_resource_metadata',
      'RFC 9728 requires the resource identifier; the server is publishing incomplete metadata.',
    );
  }
  if (!resourceCovers(metadata.resource, expectedResource)) {
    throw new OAuthError(
      `Protected-resource metadata is for ${sanitizeUrl(metadata.resource)}, ` +
        `not ${sanitizeUrl(expectedResource)}`,
      undefined,
      'resource_mismatch',
      'Check MCP_URL and MCP_OAUTH_RESOURCE: the server describes a different resource.',
    );
  }
  for (const server of metadata.authorizationServers) {
    if (!isSecureUrl(server)) {
      throw new OAuthError(
        `Protected-resource metadata names an authorization server that is not HTTPS: ${sanitizeUrl(server)}`,
        undefined,
        'untrusted_host',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Discovery: authorization-server metadata (RFC 8414 / OIDC Discovery)
// ---------------------------------------------------------------------------

export interface AuthorizationServerMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  revocationEndpoint?: string;
  scopesSupported?: string[];
  codeChallengeMethodsSupported?: string[];
  responseTypesSupported?: string[];
  grantTypesSupported?: string[];
  /** RFC 9207: the server adds `iss` to authorization responses. */
  authorizationResponseIssParameterSupported?: boolean;
  /** Where the document was read from. */
  metadataUrl?: string;
  /** False when the document declared no issuer and the requested one was assumed. */
  issuerDeclared?: boolean;
}

/**
 * Every place an issuer's metadata may live, in the order the MCP spec asks
 * clients to try them. For an issuer with a path that is three locations: the
 * RFC 8414 inserted form, OIDC's inserted form, and OIDC's original appended
 * form - which is the one most enterprise identity providers actually serve.
 */
export function authorizationServerMetadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, '');
  const candidates = path
    ? [
        `${url.origin}/.well-known/oauth-authorization-server${path}`,
        `${url.origin}/.well-known/openid-configuration${path}`,
        `${url.origin}${path}/.well-known/openid-configuration`,
      ]
    : [
        `${url.origin}/.well-known/oauth-authorization-server`,
        `${url.origin}/.well-known/openid-configuration`,
      ];
  return [...new Set(candidates)];
}

function parseAuthorizationServerMetadata(
  body: Record<string, unknown>,
  source: string,
  assumedIssuer: string | undefined,
): AuthorizationServerMetadata {
  const authorizationEndpoint = body.authorization_endpoint;
  const tokenEndpoint = body.token_endpoint;
  if (typeof authorizationEndpoint !== 'string' || typeof tokenEndpoint !== 'string') {
    throw new OAuthError(
      `${sanitizeUrl(source)} is missing authorization_endpoint or token_endpoint`,
      undefined,
      'invalid_authorization_server_metadata',
    );
  }
  const declared = typeof body.issuer === 'string' ? body.issuer : undefined;
  if (!declared && !assumedIssuer) {
    throw new OAuthError(
      `${sanitizeUrl(source)} declares no issuer`,
      undefined,
      'invalid_authorization_server_metadata',
    );
  }
  return {
    issuer: declared ?? assumedIssuer!,
    issuerDeclared: declared !== undefined,
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint:
      typeof body.registration_endpoint === 'string' ? body.registration_endpoint : undefined,
    revocationEndpoint:
      typeof body.revocation_endpoint === 'string' ? body.revocation_endpoint : undefined,
    scopesSupported: asStringArray(body.scopes_supported),
    codeChallengeMethodsSupported: asStringArray(body.code_challenge_methods_supported),
    responseTypesSupported: asStringArray(body.response_types_supported),
    grantTypesSupported: asStringArray(body.grant_types_supported),
    authorizationResponseIssParameterSupported:
      body.authorization_response_iss_parameter_supported === true,
    metadataUrl: source,
  };
}

/** Same issuer, allowing only for a trailing slash written one way and read the other. */
export function issuersMatch(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

/**
 * Loads authorization-server metadata, validating that each document belongs
 * to the issuer it was looked up for (RFC 8414 §3.3). A document claiming a
 * different issuer is skipped rather than trusted - that check is what defeats
 * an authorization-server mix-up.
 *
 * `discoveryUrl`, when configured, is a fallback only: the derived locations
 * are tried first and the configured document last.
 */
export async function loadAuthorizationServerMetadata(
  options: { issuer?: string; discoveryUrl?: string } & OAuthContext,
): Promise<AuthorizationServerMetadata> {
  const candidates = [
    ...(options.issuer ? authorizationServerMetadataUrls(options.issuer) : []),
    ...(options.discoveryUrl ? [options.discoveryUrl] : []),
  ];
  if (candidates.length === 0) {
    throw new OAuthError(
      'No authorization server is known: discovery found none and no authority is configured',
      undefined,
      'missing_configuration',
      'Set MCP_OAUTH_AUTHORITY or MCP_OAUTH_DISCOVERY_URL for this project.',
    );
  }

  const failures: string[] = [];
  let unreachable: OAuthError | undefined;
  for (const candidate of [...new Set(candidates)]) {
    try {
      const body = (await fetchJson(candidate, options)) as Record<string, unknown>;
      const metadata = parseAuthorizationServerMetadata(body, candidate, options.issuer);
      if (options.issuer && !issuersMatch(metadata.issuer, options.issuer)) {
        throw new OAuthError(
          `${sanitizeUrl(candidate)} declares issuer ${metadata.issuer}, not ${options.issuer}`,
          undefined,
          'issuer_mismatch',
        );
      }
      return metadata;
    } catch (err) {
      failures.push(errorText(err));
      if (err instanceof OAuthError && (err.code === 'certificate_error' || err.code === 'network_error')) {
        // Keep the first: a certificate problem explains every later 404 too.
        unreachable ??= err;
      }
    }
  }
  if (unreachable) throw unreachable;
  const mismatch = failures.some((failure) => failure.includes('declares issuer'));
  throw new OAuthError(
    `No authorization-server metadata for ${options.issuer ?? sanitizeUrl(options.discoveryUrl)}: ${failures.at(-1)}`,
    undefined,
    mismatch ? 'issuer_mismatch' : 'invalid_authorization_server_metadata',
    mismatch
      ? 'The metadata belongs to a different issuer. Check MCP_OAUTH_AUTHORITY - for multi-tenant identity providers use the tenant-specific authority.'
      : 'Set MCP_OAUTH_DISCOVERY_URL to the exact metadata document if the server publishes it somewhere non-standard.',
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
  const candidates = authorizationServerMetadataUrls(issuer).concat(
    wellKnownUrls(issuer, 'oauth-authorization-server'),
    wellKnownUrls(issuer, 'openid-configuration'),
  );

  let lastError: unknown;
  for (const candidate of [...new Set(candidates)]) {
    try {
      const body = (await fetchJson(candidate, context)) as Record<string, unknown>;
      return parseAuthorizationServerMetadata(body, candidate, issuer);
    } catch (err) {
      lastError = err;
    }
  }
  throw new OAuthError(
    `No authorization-server metadata for ${issuer}: ${errorText(lastError)}`,
    lastError,
    'invalid_authorization_server_metadata',
  );
}

export interface CapabilityCheck {
  /** Problems that make the flow impossible or unsafe. */
  errors: OAuthError[];
  /** Things that could not be verified, worth surfacing but not fatal. */
  warnings: string[];
}

/**
 * Confirms the server supports what this client is about to do: the code flow
 * and PKCE with S256. An omitted list cannot be verified either way; that is a
 * warning by default and an error in strict mode, because many identity
 * providers support PKCE without advertising it.
 */
export function checkAuthorizationServerCapabilities(
  metadata: AuthorizationServerMetadata,
  options: { strict?: boolean } = {},
): CapabilityCheck {
  const errors: OAuthError[] = [];
  const warnings: string[] = [];

  if (metadata.responseTypesSupported && !metadata.responseTypesSupported.includes('code')) {
    errors.push(
      new OAuthError(
        `${metadata.issuer} does not support response_type=code`,
        undefined,
        'unsupported_grant',
      ),
    );
  }
  if (metadata.grantTypesSupported && !metadata.grantTypesSupported.includes('authorization_code')) {
    errors.push(
      new OAuthError(
        `${metadata.issuer} does not support the authorization_code grant`,
        undefined,
        'unsupported_grant',
      ),
    );
  }

  if (metadata.codeChallengeMethodsSupported) {
    if (!metadata.codeChallengeMethodsSupported.includes('S256')) {
      errors.push(
        new OAuthError(
          `${metadata.issuer} does not support PKCE with S256`,
          undefined,
          'pkce_unsupported',
          'Authorization code without PKCE is not allowed; the identity provider must enable S256.',
        ),
      );
    }
  } else {
    const message = `${metadata.issuer} does not advertise code_challenge_methods_supported, so PKCE S256 support cannot be verified`;
    if (options.strict) {
      errors.push(new OAuthError(message, undefined, 'pkce_unsupported'));
    } else {
      warnings.push(`${message}; S256 is sent regardless.`);
    }
  }

  for (const [label, endpoint] of [
    ['authorization_endpoint', metadata.authorizationEndpoint],
    ['token_endpoint', metadata.tokenEndpoint],
    ['registration_endpoint', metadata.registrationEndpoint],
  ] as const) {
    if (endpoint && !isSecureUrl(endpoint)) {
      errors.push(
        new OAuthError(
          `${label} is not HTTPS: ${sanitizeUrl(endpoint)}`,
          undefined,
          'untrusted_host',
        ),
      );
    }
  }

  return { errors, warnings };
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
  let response: Response;
  try {
    response = await fetchFrom(options)(registrationEndpoint, {
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
  } catch (err) {
    throw networkError('Client registration', err);
  }

  if (!response.ok) {
    throw new OAuthError(
      `Client registration failed: HTTP ${response.status} ${truncate(await safeText(response))}`,
      undefined,
      'dynamic_registration_unsupported',
    );
  }

  const body = (await response.json()) as Record<string, unknown>;
  if (typeof body.client_id !== 'string') {
    throw new OAuthError('Client registration returned no client_id', undefined, 'invalid_token_response');
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
// Authorization request and callback
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
  /** OpenID Connect nonce, sent when an ID token is requested. */
  nonce?: string;
}

/**
 * The URL to open in a browser. Built with URL and URLSearchParams so every
 * value is encoded by the platform rather than by hand.
 */
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
  if (request.nonce) url.searchParams.set('nonce', request.nonce);
  return url.toString();
}

export interface CallbackParams {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
  errorUri?: string;
  /** RFC 9207 issuer identifier, when the server sends one. */
  iss?: string;
}

/** Reads an authorization response from a redirect's query string. */
export function parseCallbackParams(query: URLSearchParams | string): CallbackParams {
  const params = typeof query === 'string' ? new URLSearchParams(query.replace(/^\?/, '')) : query;
  const read = (key: string) => {
    const value = params.get(key);
    return value === null ? undefined : value;
  };
  return {
    code: read('code'),
    state: read('state'),
    error: read('error'),
    errorDescription: read('error_description'),
    errorUri: read('error_uri'),
    iss: read('iss'),
  };
}

/**
 * Turns an error redirect into something a person can act on. The description
 * the server sends is shown as-is - it is the most specific thing available -
 * with a hint where the cause is recognisable.
 */
export function callbackError(params: CallbackParams): OAuthError {
  const description = params.errorDescription ? `: ${truncate(params.errorDescription, 300)}` : '';
  const detail = `${params.error}${description}`;
  const text = `${params.error ?? ''} ${params.errorDescription ?? ''}`.toLowerCase();

  if (params.error === 'access_denied') {
    return new OAuthError(`Sign-in was cancelled or denied (${detail})`, undefined, 'login_cancelled');
  }
  if (text.includes('redirect_uri') || text.includes('redirect uri') || text.includes('reply url')) {
    return new OAuthError(
      `The identity provider rejected the redirect URI (${detail})`,
      undefined,
      'redirect_uri_mismatch',
      'Register the redirect URI shown in "MCP Lab: Auth" with the identity provider, or set MCP_OAUTH_REDIRECT_URI to one that is registered.',
    );
  }
  if (text.includes('resource') && (text.includes('parameter') || text.includes('not supported'))) {
    return new OAuthError(
      `The identity provider rejected the resource parameter (${detail})`,
      undefined,
      'oauth_error',
      'Set "oauth.resourceParameter" to "never" for this project; some identity providers identify the API through scopes instead.',
    );
  }
  if (params.error === 'invalid_scope') {
    return new OAuthError(
      `The identity provider rejected the requested scopes (${detail})`,
      undefined,
      'scope_not_granted',
      'Check MCP_OAUTH_SCOPES against the scopes the API exposes.',
    );
  }
  return new OAuthError(`Authorization failed (${detail})`, undefined, 'oauth_error');
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms, or undefined when the server did not say. */
  expiresAt?: number;
  scope?: string;
  tokenType: string;
  /** OpenID Connect ID token, when one was returned. Validated, never stored. */
  idToken?: string;
  /** When the token response arrived. */
  issuedAt?: number;
}

function readExpiresIn(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // A few servers send it as a string; RFC 6749 says number.
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function toTokenSet(body: Record<string, unknown>, now: number, previous?: TokenSet): TokenSet {
  if (typeof body.access_token !== 'string' || !body.access_token) {
    throw new OAuthError('Token response contained no access_token', undefined, 'invalid_token_response');
  }
  if (typeof body.token_type === 'string' && body.token_type.toLowerCase() !== 'bearer') {
    throw new OAuthError(
      `Token response has token_type "${body.token_type}"; only Bearer tokens can be sent to an MCP server`,
      undefined,
      'invalid_token_response',
    );
  }
  const expiresIn = readExpiresIn(body.expires_in);
  return {
    accessToken: body.access_token,
    // A refresh response may omit the refresh token, which means keep the old one.
    refreshToken:
      typeof body.refresh_token === 'string' ? body.refresh_token : previous?.refreshToken,
    expiresAt: expiresIn !== undefined ? now + expiresIn * 1000 : previous?.expiresAt,
    scope: typeof body.scope === 'string' ? body.scope : previous?.scope,
    tokenType: typeof body.token_type === 'string' ? body.token_type : 'Bearer',
    idToken: typeof body.id_token === 'string' ? body.id_token : undefined,
    issuedAt: now,
  };
}

/** Maps a token-endpoint error body to a code a person can act on. */
function tokenEndpointError(status: number, parsed: Record<string, unknown>, text: string): OAuthError {
  const error = typeof parsed.error === 'string' ? parsed.error : undefined;
  const description =
    typeof parsed.error_description === 'string' ? parsed.error_description : undefined;
  const detail = description ?? error ?? text;
  const message = `Token endpoint returned HTTP ${status}: ${truncate(detail)}`;
  const lower = `${error ?? ''} ${description ?? ''}`.toLowerCase();

  if (lower.includes('redirect_uri') || lower.includes('redirect uri') || lower.includes('reply url')) {
    return new OAuthError(
      message,
      undefined,
      'redirect_uri_mismatch',
      'The redirect URI sent with the code must exactly match the one registered and the one used to authorize.',
    );
  }
  if (error === 'invalid_client' || error === 'unauthorized_client') {
    return new OAuthError(
      message,
      undefined,
      'code_exchange_failed',
      'Check MCP_OAUTH_CLIENT_ID. A public client must be registered with PKCE enabled and no client secret requirement.',
    );
  }
  if (error === 'invalid_scope') {
    return new OAuthError(message, undefined, 'scope_not_granted');
  }
  return new OAuthError(message, undefined, 'code_exchange_failed');
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

  let response: Response;
  try {
    response = await fetchFrom(context)(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
      redirect: 'error',
    });
  } catch (err) {
    throw networkError('Token request', err);
  }

  const text = await safeText(response);
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // fall through to the status check, which gives a better message
  }

  if (!response.ok) {
    throw tokenEndpointError(response.status, parsed, text);
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
    /** Requested again so a rotated token keeps the same reach. */
    scope?: string;
  } & OAuthContext,
): Promise<TokenSet> {
  if (!options.tokens.refreshToken) {
    throw new OAuthError(
      'No refresh token; the user has to sign in again',
      undefined,
      'sign_in_required',
    );
  }
  let body: Record<string, unknown>;
  try {
    body = await postForm(
      options.metadata.tokenEndpoint,
      {
        grant_type: 'refresh_token',
        refresh_token: options.tokens.refreshToken,
        client_id: options.clientId,
        client_secret: options.clientSecret,
        resource: options.resource,
        scope: options.scope,
      },
      options,
    );
  } catch (err) {
    if (err instanceof OAuthError && err.code !== 'network_error' && err.code !== 'certificate_error') {
      throw new OAuthError(err.message, err, 'refresh_failed', err.hint);
    }
    throw err;
  }
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
// Scopes
// ---------------------------------------------------------------------------

/** Scopes an identity provider may legitimately leave out of `scope` in a response. */
const META_SCOPES = new Set(['offline_access', 'openid', 'profile', 'email']);

/** Splits a scope string or list into distinct, trimmed scopes. */
export function parseScopes(value: string | string[] | undefined): string[] {
  const parts = Array.isArray(value) ? value : (value ?? '').split(/[\s,]+/);
  return [...new Set(parts.map((part) => part.trim()).filter(Boolean))];
}

/**
 * The requested scopes the server did not grant. An omitted `scope` in the
 * response means "as requested" (RFC 6749 §5.1). Identity providers often
 * answer with the short form of a URI scope (`Mcp.Read` for
 * `api://app/Mcp.Read`), so the last path segment also counts as a match.
 */
export function missingScopes(requested: string[], granted: string | undefined): string[] {
  if (granted === undefined) return [];
  const have = new Set(parseScopes(granted).map((scope) => scope.toLowerCase()));
  const shortForm = (scope: string) => scope.slice(scope.lastIndexOf('/') + 1).toLowerCase();
  return requested.filter((scope) => {
    if (META_SCOPES.has(scope.toLowerCase())) return false;
    if (have.has(scope.toLowerCase())) return false;
    return ![...have].some((grantedScope) => shortForm(grantedScope) === shortForm(scope));
  });
}

// ---------------------------------------------------------------------------
// Tokens as JWTs
// ---------------------------------------------------------------------------

export type JwtClaims = Record<string, unknown> & {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  nonce?: string;
};

/**
 * Reads a JWT's claims without verifying its signature. That is deliberate and
 * sufficient here: an ID token arrives straight from the token endpoint over
 * TLS (OIDC Core §3.1.3.7 allows TLS in place of the signature for this case),
 * and access tokens are the resource server's to verify, not the client's.
 * Returns undefined for anything that is not a JWT, i.e. an opaque token.
 */
export function decodeJwt(token: string): { header: Record<string, unknown>; claims: JwtClaims } | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const decode = (part: string) =>
      JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    const header = decode(parts[0]);
    const claims = decode(parts[1]);
    if (!header || typeof header !== 'object' || !claims || typeof claims !== 'object') return undefined;
    return { header, claims };
  } catch {
    return undefined;
  }
}

function audiences(claims: JwtClaims): string[] {
  if (Array.isArray(claims.aud)) return claims.aud.filter((a): a is string => typeof a === 'string');
  return typeof claims.aud === 'string' ? [claims.aud] : [];
}

function checkTimes(claims: JwtClaims, label: string, now: number, errors: OAuthError[]): void {
  if (typeof claims.exp === 'number' && claims.exp * 1000 + CLOCK_SKEW_MS < now) {
    errors.push(new OAuthError(`The ${label} has already expired`, undefined, 'token_expired'));
  }
  if (typeof claims.nbf === 'number' && claims.nbf * 1000 - CLOCK_SKEW_MS > now) {
    errors.push(
      new OAuthError(
        `The ${label} is not valid yet (nbf is in the future); check this machine's clock`,
        undefined,
        'token_expired',
      ),
    );
  }
}

/**
 * OpenID Connect ID token validation (Core §3.1.3.7): issuer, audience, nonce
 * and lifetime. The ID token is what says who signed in, so every check here
 * is an error rather than a warning.
 */
export function validateIdToken(
  idToken: string,
  expected: { issuer: string; clientId: string; nonce?: string; now?: number },
): { claims: JwtClaims; errors: OAuthError[] } {
  const now = expected.now ?? Date.now();
  const decoded = decodeJwt(idToken);
  if (!decoded) {
    return {
      claims: {},
      errors: [new OAuthError('The ID token is not a valid JWT', undefined, 'invalid_token_response')],
    };
  }
  const { claims } = decoded;
  const errors: OAuthError[] = [];

  if (!issuersMatch(claims.iss, expected.issuer)) {
    errors.push(
      new OAuthError(
        `The ID token was issued by ${claims.iss ?? '(no issuer)'}, not ${expected.issuer}`,
        undefined,
        'wrong_issuer',
      ),
    );
  }
  if (!audiences(claims).includes(expected.clientId)) {
    errors.push(
      new OAuthError('The ID token was not issued to this client', undefined, 'wrong_audience'),
    );
  }
  if (expected.nonce !== undefined && !secretsEqual(claims.nonce, expected.nonce)) {
    errors.push(
      new OAuthError(
        'The ID token nonce does not match the sign-in request',
        undefined,
        'state_mismatch',
      ),
    );
  }
  checkTimes(claims, 'ID token', now, errors);
  return { claims, errors };
}

export interface AccessTokenInspection {
  claims?: JwtClaims;
  errors: OAuthError[];
  warnings: string[];
}

/**
 * What can be checked about an access token from the client side. OAuth treats
 * access tokens as opaque to clients, and real identity providers issue
 * audiences and issuers that differ from the MCP URL for legitimate reasons
 * (application ID URIs, v1/v2 issuer formats). So: lifetime is always enforced;
 * issuer and audience are enforced when the project pins them, when strict mode
 * is on, or when the audience is plainly another web resource; otherwise a
 * mismatch is reported as a warning.
 */
export function inspectAccessToken(
  accessToken: string,
  expected: {
    issuer?: string;
    /** Values the audience may legitimately take: resource, MCP URL, configured audience. */
    audiences: string[];
    /** Configured audience: when present, the audience must include it. */
    pinnedAudience?: string;
    strict?: boolean;
    now?: number;
  },
): AccessTokenInspection {
  const now = expected.now ?? Date.now();
  const decoded = decodeJwt(accessToken);
  const errors: OAuthError[] = [];
  const warnings: string[] = [];
  if (!decoded) {
    if (expected.pinnedAudience || expected.strict) {
      warnings.push('The access token is opaque, so its audience and issuer cannot be checked here.');
    }
    return { errors, warnings };
  }
  const { claims } = decoded;
  checkTimes(claims, 'access token', now, errors);

  if (expected.issuer && claims.iss && !issuersMatch(claims.iss, expected.issuer)) {
    const message = `The access token issuer is ${claims.iss}, not ${expected.issuer}`;
    if (expected.strict) errors.push(new OAuthError(message, undefined, 'wrong_issuer'));
    else warnings.push(`${message}. Some identity providers issue access tokens under a different issuer format.`);
  }

  const tokenAudiences = audiences(claims);
  if (tokenAudiences.length > 0) {
    const accepted = new Set(
      [...expected.audiences, ...(expected.pinnedAudience ? [expected.pinnedAudience] : [])].map(
        normalizeUrl,
      ),
    );
    const matches = tokenAudiences.some((aud) => accepted.has(normalizeUrl(aud)));
    if (!matches) {
      const pinnedMissing =
        expected.pinnedAudience !== undefined &&
        !tokenAudiences.some((aud) => normalizeUrl(aud) === normalizeUrl(expected.pinnedAudience!));
      const foreignWebResource = tokenAudiences.every((aud) => {
        const url = tryParseUrl(aud);
        return !!url && (url.protocol === 'https:' || url.protocol === 'http:');
      });
      const message = `The access token audience (${tokenAudiences.join(', ')}) does not match this MCP resource`;
      if (pinnedMissing || expected.strict || foreignWebResource) {
        errors.push(
          new OAuthError(
            message,
            undefined,
            'wrong_audience',
            'A token meant for another resource must never be sent here. Check MCP_OAUTH_RESOURCE and the requested scopes.',
          ),
        );
      } else {
        warnings.push(`${message}; set "oauth.audience" to enforce the expected value.`);
      }
    }
  }
  return { claims, errors, warnings };
}

/** Who signed in, from whichever token says. Labels are for display only. */
export function accountFromClaims(
  ...sources: Array<JwtClaims | undefined>
): { id?: string; label?: string } {
  for (const claims of sources) {
    if (!claims) continue;
    const id =
      typeof claims.oid === 'string'
        ? claims.oid
        : typeof claims.sub === 'string'
          ? claims.sub
          : undefined;
    const label = ['preferred_username', 'email', 'upn', 'unique_name', 'name']
      .map((key) => claims[key])
      .find((value): value is string => typeof value === 'string' && value.length > 0);
    if (id || label) return { id, label: label ?? id };
  }
  return {};
}

// ---------------------------------------------------------------------------

function networkError(what: string, err: unknown): OAuthError {
  const failure = describeNetworkFailure(err);
  return new OAuthError(`${what} failed: ${failure.message}`, err, failure.code, failure.hint);
}

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
