/**
 * OAuth sessions for MCP projects: discovery, sign-in, storage and refresh.
 *
 * This is the orchestration over the protocol primitives in oauth.ts. It is in
 * core, not in the extension, so the entire flow - discovery, the browser round
 * trip, the code exchange, refresh, isolation between projects - runs under
 * test against real HTTP servers. The editor supplies only what it alone can:
 * secret storage, a browser, a URI handler and a place to write diagnostics.
 *
 * What it guarantees:
 *   - Discovery is validated hop by hop. Metadata must describe the configured
 *     resource; an authorization server must be the configured one, or a host
 *     the user approved; endpoints must be HTTPS on a trusted host.
 *   - Every sign-in uses fresh state, PKCE verifier and nonce, single-use.
 *   - Tokens are stored per project and per account, bound to the endpoint,
 *     resource and client they were issued for. Change any of those and the old
 *     tokens are discarded, not reused.
 *   - A token is only handed out for requests to its own project's origin.
 *   - Refreshes are serialised per project; a 401 triggers at most one refresh.
 *   - Logs carry events and hosts, never tokens, codes, verifiers, states,
 *     nonces, secrets or full authorization URLs.
 */

import { Emitter } from './events';
import {
  OAuthError,
  accountFromClaims,
  buildAuthorizationUrl,
  callbackError,
  checkAuthorizationServerCapabilities,
  createNonce,
  createPkce,
  createState,
  exchangeAuthorizationCode,
  fetchProtectedResourceMetadata,
  findBearerChallenge,
  fingerprint,
  inspectAccessToken,
  isLoopbackHost,
  isSecureUrl,
  issuersMatch,
  loadAuthorizationServerMetadata,
  missingScopes,
  needsRefresh,
  normalizeUrl,
  parseScopes,
  refreshAccessToken,
  registerClient,
  sameOrigin,
  sanitizeUrl,
  secretsEqual,
  tryParseUrl,
  validateIdToken,
  validateProtectedResourceMetadata,
  wellKnownUrls,
  type AuthorizationServerMetadata,
  type CallbackParams,
  type ClientRegistration,
  type JwtClaims,
  type ProtectedResourceMetadata,
  type TokenSet,
} from './oauth';
import {
  CALLBACK_PATH,
  PendingAuthorizations,
  startLoopbackReceiver,
  type DeliveryOutcome,
} from './oauthCallback';
import { bindingKey, blockingIssues, describeIssues, type ResolvedProject } from './projects';
import { describeNetworkFailure } from './netErrors';
import { redact } from './redaction';

const INDEX_KEY = 'mcplab.auth.index';
const TRUSTED_ISSUERS_KEY = 'mcplab.auth.trustedIssuers';
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 15_000;
const PROBE_PROTOCOL_VERSION = '2025-06-18';

export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Non-secret persistent state: the session index and approved issuers. */
export interface KeyValueStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Promise<void>;
}

export type AuthLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AuthLogger {
  log(level: AuthLogLevel, projectId: string | undefined, message: string, detail?: Record<string, unknown>): void;
}

export interface OAuthSessionHost {
  secrets: SecretStore;
  state: KeyValueStore;
  logger: AuthLogger;
  /** Opens the authorization URL in the user's browser; false if it could not. */
  openBrowser(url: string): Promise<boolean>;
  /** The editor-routed redirect URI, already made external. Undefined when there is none. */
  editorRedirectUri?(): Promise<string | undefined>;
  /** Maps a loopback URL to one the user's browser can reach (remote port forwarding). */
  externalizeLoopback?(url: string): Promise<string>;
  /** Why browser sign-in cannot work here, if it cannot. */
  unsupportedReason?(mode: 'uri' | 'loopback'): string | undefined;
  /** Asks whether to trust an authorization server the configuration did not name. */
  approveAuthorizationServer?(project: ResolvedProject, issuer: string): Promise<boolean>;
  /** A confidential client's secret, read at the moment of use. */
  readClientSecret?(project: ResolvedProject): Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  clientName?: string;
}

export interface DiscoveryResult {
  issuer: string;
  metadata: AuthorizationServerMetadata;
  protectedResource?: ProtectedResourceMetadata;
  /** The resource identifier the token is for. */
  resource: string;
  /** Whether the `resource` parameter is sent with authorization and token requests. */
  sendResource: boolean;
  scopes: string[];
  /** What discovery did, step by step, safe to show. */
  steps: string[];
  warnings: string[];
}

/** Everything about a session that is safe to show or persist in plain state. */
export interface SessionInfo {
  sessionId: string;
  projectId: string;
  accountKey: string;
  accountId: string;
  accountLabel: string;
  scopes: string[];
  issuer: string;
  expiresAt?: number;
  hasRefreshToken: boolean;
  signedInAt: number;
  bindingKey: string;
}

export interface SessionChange {
  projectId: string;
  kind: 'added' | 'removed' | 'changed';
  session?: SessionInfo;
}

interface TokenMetadata {
  version: 1;
  projectId: string;
  bindingKey: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  dynamicClient: boolean;
  /** The `resource` value sent, when it was sent. */
  resource?: string;
  /** For audience checks after a refresh. */
  audiences: string[];
  requestedScopes: string[];
  grantedScope?: string;
  tokenType: string;
  expiresAt?: number;
  mcpOrigin: string;
}

interface LoadedSession {
  info: SessionInfo;
  accessToken: string;
  refreshToken?: string;
  meta: TokenMetadata;
}

interface ClientChoice {
  clientId: string;
  clientSecret?: string;
  dynamic: boolean;
}

interface PreparedRedirect {
  mode: 'uri' | 'loopback';
  redirectUri: string;
  callbackPath: string;
  dispose(): Promise<void>;
}

export class SignInRequiredError extends OAuthError {
  constructor(project: Pick<ResolvedProject, 'id' | 'displayName'>, reason: string, cause?: unknown) {
    super(
      `Sign-in required for ${project.displayName}: ${reason}`,
      cause,
      'sign_in_required',
      'Run "MCP: Connect" or "MCP: Reauthenticate" to sign in.',
    );
    this.name = 'SignInRequiredError';
  }
}

const SENSITIVE_DETAIL_KEYS = new Set([
  'code',
  'state',
  'nonce',
  'verifier',
  'code_verifier',
  'access_token',
  'accesstoken',
  'refresh_token',
  'refreshtoken',
  'id_token',
  'idtoken',
  'client_secret',
  'clientsecret',
  'authorization',
  'mcp-session-id',
  'sessionid',
]);

/** Belt and braces: drops secret-named keys and masks secret-shaped strings. */
function scrub(detail: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!detail) return undefined;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (SENSITIVE_DETAIL_KEYS.has(key.toLowerCase())) continue;
    clean[key] = typeof value === 'string' ? redact(value) : value;
  }
  return clean;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class OAuthSessionManager {
  private readonly pending: PendingAuthorizations;
  private readonly refreshing = new Map<string, Promise<string>>();
  private readonly changes = new Emitter<SessionChange>();
  private readonly lastDiscovery = new Map<string, DiscoveryResult>();
  private readonly lastErrors = new Map<string, { code: string; message: string; at: number }>();
  /**
   * Loaded sessions, so the per-request token lookup does not go to the OS
   * keychain three times for every MCP call. Every write path updates or
   * evicts it.
   */
  private readonly cache = new Map<string, LoadedSession>();

  readonly onDidChangeSessions = this.changes.on.bind(this.changes);

  constructor(private readonly host: OAuthSessionHost) {
    this.pending = new PendingAuthorizations(this.now);
  }

  private readonly now = (): number => (this.host.now ? this.host.now() : Date.now());

  private log(level: AuthLogLevel, project: Pick<ResolvedProject, 'id'> | undefined, message: string, detail?: Record<string, unknown>): void {
    this.host.logger.log(level, project?.id, redact(message), scrub(detail));
  }

  // -------------------------------------------------------------------------
  // Session index (non-secret) and token storage (secret)
  // -------------------------------------------------------------------------

  private index(): Record<string, SessionInfo> {
    return { ...(this.host.state.get<Record<string, SessionInfo>>(INDEX_KEY) ?? {}) };
  }

  private secretKey(projectId: string, accountKey: string, kind: 'accessToken' | 'refreshToken' | 'tokenMetadata'): string {
    return `mcplab.auth.${projectId}.${accountKey}.${kind}`;
  }

  /** The signed-in session for a project, if any. Does not touch secret storage. */
  session(projectId: string): SessionInfo | undefined {
    return this.index()[projectId];
  }

  sessions(): SessionInfo[] {
    return Object.values(this.index());
  }

  private async loadSession(project: ResolvedProject): Promise<LoadedSession | undefined> {
    const info = this.index()[project.id];
    if (!info) {
      this.cache.delete(project.id);
      return undefined;
    }

    const cached = this.cache.get(project.id);
    if (cached && cached.info.sessionId === info.sessionId && info.bindingKey === bindingKey(project)) {
      return cached;
    }

    if (info.bindingKey !== bindingKey(project)) {
      this.log('warn', project, 'Stored session was for a different endpoint, resource or client; it has been discarded');
      await this.deleteSession(project.id);
      return undefined;
    }

    const [accessToken, refreshToken, rawMeta] = await Promise.all([
      this.host.secrets.get(this.secretKey(project.id, info.accountKey, 'accessToken')),
      this.host.secrets.get(this.secretKey(project.id, info.accountKey, 'refreshToken')),
      this.host.secrets.get(this.secretKey(project.id, info.accountKey, 'tokenMetadata')),
    ]);
    let meta: TokenMetadata | undefined;
    try {
      meta = rawMeta ? (JSON.parse(rawMeta) as TokenMetadata) : undefined;
    } catch {
      meta = undefined;
    }
    if (!accessToken || !meta || meta.projectId !== project.id || meta.bindingKey !== info.bindingKey) {
      this.log('warn', project, 'Stored session was incomplete or did not match the project; it has been discarded');
      await this.deleteSession(project.id);
      return undefined;
    }
    const loaded = { info, accessToken, refreshToken, meta };
    this.cache.set(project.id, loaded);
    return loaded;
  }

  private async deleteSession(projectId: string): Promise<void> {
    this.cache.delete(projectId);
    const index = this.index();
    const info = index[projectId];
    if (!info) return;
    await Promise.all(
      (['accessToken', 'refreshToken', 'tokenMetadata'] as const).map((kind) =>
        this.host.secrets.delete(this.secretKey(projectId, info.accountKey, kind)),
      ),
    );
    delete index[projectId];
    await this.host.state.update(INDEX_KEY, index);
    this.changes.fire({ projectId, kind: 'removed', session: info });
  }

  private async persist(
    project: ResolvedProject,
    discovery: DiscoveryResult,
    client: ClientChoice,
    tokens: TokenSet,
    account: { id: string; label: string },
  ): Promise<SessionInfo> {
    const binding = bindingKey(project);
    const accountKey = fingerprint(`${discovery.issuer}|${account.id}`);
    const index = this.index();
    const previous = index[project.id];

    // One active session per project: a different account replaces the old one.
    if (previous && previous.accountKey !== accountKey) {
      await Promise.all(
        (['accessToken', 'refreshToken', 'tokenMetadata'] as const).map((kind) =>
          this.host.secrets.delete(this.secretKey(project.id, previous.accountKey, kind)),
        ),
      );
    }

    const meta: TokenMetadata = {
      version: 1,
      projectId: project.id,
      bindingKey: binding,
      issuer: discovery.issuer,
      authorizationEndpoint: discovery.metadata.authorizationEndpoint,
      tokenEndpoint: discovery.metadata.tokenEndpoint,
      clientId: client.clientId,
      dynamicClient: client.dynamic,
      resource: discovery.sendResource ? discovery.resource : undefined,
      audiences: [discovery.resource, project.mcpUrl, project.oauth.resource],
      requestedScopes: discovery.scopes,
      grantedScope: tokens.scope,
      tokenType: tokens.tokenType,
      expiresAt: tokens.expiresAt,
      mcpOrigin: new URL(project.mcpUrl).origin,
    };

    await this.host.secrets.store(this.secretKey(project.id, accountKey, 'accessToken'), tokens.accessToken);
    if (tokens.refreshToken) {
      await this.host.secrets.store(this.secretKey(project.id, accountKey, 'refreshToken'), tokens.refreshToken);
    } else {
      await this.host.secrets.delete(this.secretKey(project.id, accountKey, 'refreshToken'));
    }
    await this.host.secrets.store(this.secretKey(project.id, accountKey, 'tokenMetadata'), JSON.stringify(meta));

    const info: SessionInfo = {
      sessionId: fingerprint(`${project.id}|${binding}|${accountKey}`),
      projectId: project.id,
      accountKey,
      accountId: account.id,
      accountLabel: account.label,
      scopes: parseScopes(tokens.scope ?? discovery.scopes),
      issuer: discovery.issuer,
      expiresAt: tokens.expiresAt,
      hasRefreshToken: !!tokens.refreshToken,
      signedInAt: previous?.accountKey === accountKey ? previous.signedInAt : this.now(),
      bindingKey: binding,
    };
    index[project.id] = info;
    await this.host.state.update(INDEX_KEY, index);
    this.cache.set(project.id, {
      info,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      meta,
    });
    this.changes.fire({ projectId: project.id, kind: previous ? 'changed' : 'added', session: info });
    return info;
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  private trustedHosts(project: ResolvedProject): Set<string> {
    const hosts = new Set<string>(project.oauth.trustedHosts.map((host) => host.toLowerCase()));
    for (const value of [
      project.mcpUrl,
      project.oauth.authority,
      project.oauth.discoveryUrl,
      project.oauth.protectedResourceMetadataUrl,
    ]) {
      const url = tryParseUrl(value);
      if (url) hosts.add(url.host.toLowerCase());
    }
    return hosts;
  }

  private approvedIssuers(projectId: string): string[] {
    return this.host.state.get<Record<string, string[]>>(TRUSTED_ISSUERS_KEY)?.[projectId] ?? [];
  }

  private async rememberIssuer(projectId: string, issuer: string): Promise<void> {
    const all = { ...(this.host.state.get<Record<string, string[]>>(TRUSTED_ISSUERS_KEY) ?? {}) };
    all[projectId] = [...new Set([...(all[projectId] ?? []), issuer])];
    await this.host.state.update(TRUSTED_ISSUERS_KEY, all);
  }

  /** Sends the unauthenticated request discovery starts from, and reads its challenge. */
  private async probe(project: ResolvedProject): Promise<{ status: number; challengeHeader?: string }> {
    const fetchImpl = this.host.fetchImpl ?? globalThis.fetch;
    let response: Response;
    try {
      response = await fetchImpl(project.mcpUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': PROBE_PROTOCOL_VERSION,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'mcplab-auth-probe',
          method: 'initialize',
          params: {
            protocolVersion: PROBE_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'mcplab', version: '0.1.0' },
          },
        }),
        redirect: 'manual',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
    } catch (err) {
      const failure = describeNetworkFailure(err);
      throw new OAuthError(
        `Could not reach the MCP server at ${sanitizeUrl(project.mcpUrl)}: ${failure.message}`,
        err,
        failure.code,
        failure.hint,
      );
    }
    const challengeHeader = response.headers.get('www-authenticate') ?? undefined;
    await response.body?.cancel().catch(() => undefined);
    return { status: response.status, challengeHeader };
  }

  /**
   * Finds and validates the authorization server for a project, in the order
   * the MCP authorization spec lays out. Configured metadata URLs are used
   * only when discovery cannot find the answer itself.
   */
  async discover(project: ResolvedProject): Promise<DiscoveryResult> {
    const steps: string[] = [];
    const warnings: string[] = [];
    const trusted = this.trustedHosts(project);
    const mcpUrl = project.mcpUrl;
    this.log('info', project, 'Protected-resource discovery started', { mcpUrl: sanitizeUrl(mcpUrl) });

    // 1-4. Unauthenticated request; read the Bearer challenge.
    const probe = await this.probe(project);
    let challengeMetadataUrl: string | undefined;
    let challengeScope: string | undefined;
    if (probe.status === 401) {
      const bearer = findBearerChallenge(probe.challengeHeader);
      if (!probe.challengeHeader) {
        steps.push('MCP endpoint answered 401 without a WWW-Authenticate header');
        warnings.push('The MCP server sent no WWW-Authenticate header with its 401; falling back to well-known metadata.');
      } else if (!bearer) {
        steps.push('MCP endpoint answered 401 without a Bearer challenge');
        warnings.push('The 401 challenge is not a Bearer challenge; falling back to well-known metadata.');
      } else {
        challengeMetadataUrl = bearer.params.resource_metadata;
        challengeScope = bearer.params.scope;
        steps.push(
          challengeMetadataUrl
            ? `MCP endpoint answered 401 naming metadata at ${sanitizeUrl(challengeMetadataUrl)}`
            : 'MCP endpoint answered 401 with a Bearer challenge but no resource_metadata',
        );
      }
    } else if (probe.status >= 200 && probe.status < 300) {
      steps.push(`MCP endpoint answered ${probe.status} without credentials`);
      warnings.push('The MCP server accepted an unauthenticated request; it may not require OAuth at all.');
    } else {
      steps.push(`MCP endpoint answered HTTP ${probe.status} to an unauthenticated request`);
      if (probe.status === 404) {
        warnings.push('HTTP 404 from the MCP URL: check that it is the MCP transport endpoint.');
      }
    }

    // The challenge may point anywhere; only follow it somewhere trustworthy.
    if (challengeMetadataUrl) {
      const url = tryParseUrl(challengeMetadataUrl);
      const allowed =
        !!url &&
        isSecureUrl(url) &&
        (sameOrigin(challengeMetadataUrl, mcpUrl) ||
          (project.oauth.protectedResourceMetadataUrl !== undefined &&
            normalizeUrl(challengeMetadataUrl) === normalizeUrl(project.oauth.protectedResourceMetadataUrl)) ||
          trusted.has(url.host.toLowerCase()));
      if (!allowed) {
        throw new OAuthError(
          `The MCP server pointed discovery at ${sanitizeUrl(challengeMetadataUrl)}, which is not on a trusted host`,
          undefined,
          'untrusted_host',
          `If that host is legitimate, add "${url?.host ?? challengeMetadataUrl}" to oauth.trustedHosts for this project.`,
        );
      }
    }

    // 5-7. Protected-resource metadata, validated against the configured resource.
    const expectedResource = project.oauth.resource || mcpUrl;
    const candidates = [
      ...(challengeMetadataUrl ? [challengeMetadataUrl] : []),
      ...wellKnownUrls(mcpUrl, 'oauth-protected-resource'),
      ...(project.oauth.protectedResourceMetadataUrl ? [project.oauth.protectedResourceMetadataUrl] : []),
    ];
    let protectedResource: ProtectedResourceMetadata | undefined;
    let prmFailure: OAuthError | undefined;
    for (const candidate of [...new Set(candidates.map((c) => c))]) {
      try {
        const metadata = await fetchProtectedResourceMetadata(candidate, this.fetchContext());
        validateProtectedResourceMetadata(metadata, expectedResource);
        protectedResource = metadata;
        steps.push(`Protected-resource metadata loaded from ${sanitizeUrl(candidate)}`);
        break;
      } catch (err) {
        const failure = err instanceof OAuthError ? err : new OAuthError(errorText(err), err);
        // A document that exists but describes another resource is a hard stop:
        // falling through to the next candidate would hide a misconfiguration.
        if (failure.code === 'resource_mismatch' || failure.code === 'untrusted_host') throw failure;
        if (failure.code === 'certificate_error') throw failure;
        prmFailure ??= failure;
      }
    }

    if (protectedResource) {
      this.log('info', project, 'Protected-resource metadata loaded', {
        metadataUrl: sanitizeUrl(protectedResource.metadataUrl),
        resource: sanitizeUrl(protectedResource.resource),
        authorizationServers: protectedResource.authorizationServers.length,
      });
    } else if (project.oauth.authority || project.oauth.discoveryUrl) {
      steps.push('No protected-resource metadata; using the configured authority');
      warnings.push(
        `Protected-resource metadata was not available (${prmFailure?.message ?? 'not found'}); using the configured authority.`,
      );
    } else if (challengeMetadataUrl) {
      throw new OAuthError(
        `The protected-resource metadata the server named is unusable: ${prmFailure?.message ?? 'unknown error'}`,
        prmFailure,
        'invalid_resource_metadata',
        'Set MCP_OAUTH_AUTHORITY (or MCP_OAUTH_DISCOVERY_URL) so sign-in does not depend on it.',
      );
    } else if (probe.status === 401 && !probe.challengeHeader) {
      throw new OAuthError(
        'The MCP server returned 401 without a WWW-Authenticate header, and no protected-resource metadata was found',
        prmFailure,
        'missing_www_authenticate',
        'Set MCP_OAUTH_AUTHORITY or MCP_OAUTH_PROTECTED_RESOURCE_METADATA_URL for this project.',
      );
    } else {
      throw new OAuthError(
        'No protected-resource metadata was found for the MCP server and no authority is configured',
        prmFailure,
        'missing_resource_metadata',
        'Set MCP_OAUTH_AUTHORITY or MCP_OAUTH_PROTECTED_RESOURCE_METADATA_URL for this project.',
      );
    }

    // 7-8. Choose the authorization server, guarding against mix-ups.
    let issuer: string | undefined;
    if (protectedResource) {
      const advertised = protectedResource.authorizationServers;
      if (project.oauth.authority) {
        issuer = advertised.find((server) => issuersMatch(server, project.oauth.authority));
        if (!issuer) {
          throw new OAuthError(
            `The MCP server's metadata names ${advertised.join(', ')}, but this project is configured for ${project.oauth.authority}`,
            undefined,
            'authorization_server_mismatch',
            'If the server moved identity providers, update MCP_OAUTH_AUTHORITY; otherwise do not sign in - the server may be misconfigured or compromised.',
          );
        }
      } else {
        issuer = advertised[0];
        const host = tryParseUrl(issuer)?.host.toLowerCase() ?? '';
        const known = trusted.has(host) || this.approvedIssuers(project.id).some((value) => issuersMatch(value, issuer));
        if (!known) {
          const approved = (await this.host.approveAuthorizationServer?.(project, issuer)) ?? false;
          if (!approved) {
            throw new OAuthError(
              `The MCP server wants sign-in at ${issuer}, which this project does not name and which was not approved`,
              undefined,
              'untrusted_host',
              'Set MCP_OAUTH_AUTHORITY to that issuer, or add its host to oauth.trustedHosts, if it is legitimate.',
            );
          }
          await this.rememberIssuer(project.id, issuer);
          steps.push(`Authorization server ${issuer} approved by the user`);
        }
      }
    } else {
      issuer = project.oauth.authority;
    }

    // 8-9. Authorization-server metadata, checked against that issuer.
    const metadata = await loadAuthorizationServerMetadata({
      issuer,
      discoveryUrl: project.oauth.discoveryUrl,
      ...this.fetchContext(),
    });
    issuer ??= metadata.issuer;
    steps.push(`Authorization-server metadata loaded from ${sanitizeUrl(metadata.metadataUrl)}`);

    // Endpoints must live on the issuer's host or a host the project trusts.
    const issuerHost = tryParseUrl(issuer)?.host.toLowerCase();
    for (const [label, endpoint] of [
      ['authorization_endpoint', metadata.authorizationEndpoint],
      ['token_endpoint', metadata.tokenEndpoint],
      ['registration_endpoint', metadata.registrationEndpoint],
    ] as const) {
      if (!endpoint) continue;
      const host = tryParseUrl(endpoint)?.host.toLowerCase();
      if (!host || (host !== issuerHost && !trusted.has(host))) {
        throw new OAuthError(
          `The ${label} is on ${host ?? 'an invalid URL'}, not on the issuer's host ${issuerHost}`,
          undefined,
          'untrusted_host',
          `If that is expected for this identity provider, add "${host}" to oauth.trustedHosts.`,
        );
      }
    }

    // 10. The code flow and PKCE S256 must be supported.
    const capabilities = checkAuthorizationServerCapabilities(metadata, { strict: project.oauth.strict });
    if (capabilities.errors.length) throw capabilities.errors[0];
    warnings.push(...capabilities.warnings);

    const resource = project.oauth.resourceConfigured
      ? project.oauth.resource
      : protectedResource?.resource ?? project.mcpUrl;
    const sendResource =
      project.oauth.resourceParameter === 'always' ||
      (project.oauth.resourceParameter === 'auto' &&
        (project.oauth.resourceConfigured || protectedResource?.resource !== undefined));

    const scopes = project.oauth.scopes.length
      ? project.oauth.scopes
      : parseScopes(challengeScope ?? protectedResource?.scopesSupported ?? []);

    const result: DiscoveryResult = {
      issuer,
      metadata,
      protectedResource,
      resource,
      sendResource,
      scopes,
      steps,
      warnings,
    };
    this.lastDiscovery.set(project.id, result);
    this.log('info', project, 'Authorization server discovered', {
      issuer,
      authorizationEndpoint: sanitizeUrl(metadata.authorizationEndpoint),
      tokenEndpoint: sanitizeUrl(metadata.tokenEndpoint),
      pkce: metadata.codeChallengeMethodsSupported?.includes('S256') ? 'S256 advertised' : 'not advertised',
      resourceParameter: sendResource ? 'sent' : 'not sent',
    });
    for (const warning of warnings) this.log('warn', project, warning);
    return result;
  }

  private fetchContext(): { fetchImpl?: typeof fetch; now?: () => number } {
    return { fetchImpl: this.host.fetchImpl, now: this.host.now };
  }

  // -------------------------------------------------------------------------
  // Redirect URI
  // -------------------------------------------------------------------------

  /** The callback mode a project would use here, without starting anything. */
  async describeRedirect(project: ResolvedProject): Promise<{ mode: 'uri' | 'loopback'; redirectUri: string }> {
    const configured = tryParseUrl(project.oauth.redirectUri);
    if (configured) {
      const loopback = configured.protocol === 'http:' && isLoopbackHost(configured.hostname);
      return { mode: loopback ? 'loopback' : 'uri', redirectUri: project.oauth.redirectUri! };
    }
    const mode = await this.chooseMode(project);
    if (mode === 'loopback') {
      return { mode, redirectUri: `http://127.0.0.1:<port chosen at sign-in>${CALLBACK_PATH}` };
    }
    return { mode, redirectUri: (await this.host.editorRedirectUri?.()) ?? '(unavailable)' };
  }

  private async chooseMode(project: ResolvedProject): Promise<'uri' | 'loopback'> {
    if (project.oauth.callbackMode === 'loopback') return 'loopback';
    if (project.oauth.callbackMode === 'uri') return 'uri';
    return (await this.host.editorRedirectUri?.()) ? 'uri' : 'loopback';
  }

  private async prepareRedirect(project: ResolvedProject): Promise<PreparedRedirect> {
    const configured = tryParseUrl(project.oauth.redirectUri);
    const configuredLoopback =
      !!configured && configured.protocol === 'http:' && isLoopbackHost(configured.hostname);
    const mode: 'uri' | 'loopback' = configured
      ? configuredLoopback
        ? 'loopback'
        : 'uri'
      : await this.chooseMode(project);

    const unsupported = this.host.unsupportedReason?.(mode);
    if (unsupported) {
      throw new OAuthError(unsupported, undefined, 'unsupported_environment');
    }

    if (mode === 'uri') {
      const resolved = configured ? project.oauth.redirectUri! : await this.host.editorRedirectUri?.();
      if (!resolved) {
        throw new OAuthError(
          'This editor cannot receive a sign-in callback through its URI handler',
          undefined,
          'unsupported_environment',
          'Set "oauth.callbackMode" to "loopback" for this project.',
        );
      }
      const editorUri = configured ? await this.host.editorRedirectUri?.() : resolved;
      if (configured && editorUri && normalizeUrl(editorUri) !== normalizeUrl(resolved)) {
        this.log('warn', project, 'The configured redirect URI differs from the one this editor resolves; the browser may not return here', {
          configured: sanitizeUrl(resolved),
          resolved: sanitizeUrl(editorUri),
        });
      }
      this.log('info', project, 'Redirect URI resolved', { mode, redirectUri: sanitizeUrl(resolved) });
      return { mode, redirectUri: resolved, callbackPath: CALLBACK_PATH, dispose: async () => undefined };
    }

    // Loopback: the listener must be up before the browser opens.
    const path = configured?.pathname && configured.pathname !== '/' ? configured.pathname : CALLBACK_PATH;
    const port = configured?.port ? Number(configured.port) : 0;
    const receiver = await startLoopbackReceiver({ registry: this.pending, path, port });
    try {
      const external = this.host.externalizeLoopback
        ? await this.host.externalizeLoopback(receiver.redirectUri)
        : receiver.redirectUri;
      const externalUrl = tryParseUrl(external);
      if (!externalUrl || !isLoopbackHost(externalUrl.hostname)) {
        throw new OAuthError(
          'A loopback sign-in callback cannot reach this editor from the browser in this environment',
          undefined,
          'unsupported_environment',
          'Set "oauth.callbackMode" to "uri" for this project so the editor routes the callback itself.',
        );
      }
      // An explicit loopback URI is sent verbatim so it matches the registration exactly.
      const redirectUri =
        configured && configured.port && Number(configured.port) === receiver.port && external === receiver.redirectUri
          ? project.oauth.redirectUri!
          : external;
      this.log('info', project, 'Redirect URI resolved', { mode, redirectUri: sanitizeUrl(redirectUri) });
      return { mode, redirectUri, callbackPath: path, dispose: () => receiver.close() };
    } catch (err) {
      await receiver.close();
      throw err;
    }
  }

  /** Routes a redirect from the editor's URI handler to the sign-in waiting for it. */
  deliverCallback(path: string, query: string): DeliveryOutcome {
    const outcome = this.pending.deliver(path, query);
    if (outcome !== 'accepted') {
      this.log(outcome === 'no-pending' || outcome === 'wrong-path' ? 'debug' : 'warn', undefined, `Sign-in callback ignored: ${outcome}`);
    }
    return outcome;
  }

  // -------------------------------------------------------------------------
  // Client identity
  // -------------------------------------------------------------------------

  private async clientFor(
    project: ResolvedProject,
    discovery: DiscoveryResult,
    redirectUri: string,
  ): Promise<ClientChoice> {
    if (project.oauth.clientId) {
      let clientSecret: string | undefined;
      if (project.oauth.clientSecretSource) {
        clientSecret = await this.host.readClientSecret?.(project);
        if (!clientSecret) {
          throw new OAuthError(
            'A client secret is configured for this project but could not be read',
            undefined,
            'missing_configuration',
            'Check the environment variable or secure-storage entry it points at.',
          );
        }
        this.log('warn', project, 'Using a confidential-client secret. A desktop extension should normally be a public client using PKCE alone.', {
          secretSource: project.oauth.clientSecretSource.kind === 'environment'
            ? `environment variable ${project.oauth.clientSecretSource.variable}`
            : 'secure storage',
        });
      }
      return { clientId: project.oauth.clientId, clientSecret, dynamic: false };
    }

    if (project.origin !== 'adhoc') {
      throw new OAuthError('The OAuth client id is missing', undefined, 'missing_configuration', 'Set MCP_OAUTH_CLIENT_ID.');
    }
    if (!discovery.metadata.registrationEndpoint) {
      throw new OAuthError(
        `${discovery.issuer} does not support dynamic client registration`,
        undefined,
        'dynamic_registration_unsupported',
        'Register MCP Lab with the identity provider and configure the client id as an MCP project (MCP_OAUTH_CLIENT_ID).',
      );
    }

    // Registrations are per issuer and redirect URI: a loopback port change needs a new one.
    const key = `mcplab.oauth.client.${fingerprint(`${discovery.issuer}|${redirectUri}`)}`;
    const stored = await this.host.secrets.get(key);
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as ClientRegistration;
        const expired = parsed.clientSecretExpiresAt !== undefined && parsed.clientSecretExpiresAt <= this.now();
        if (parsed.clientId && !expired) {
          return { clientId: parsed.clientId, clientSecret: parsed.clientSecret, dynamic: true };
        }
      } catch {
        // fall through to a fresh registration
      }
    }
    const registration = await registerClient(discovery.metadata.registrationEndpoint, {
      clientName: this.host.clientName ?? 'MCP Lab',
      redirectUri,
      scope: discovery.scopes.join(' ') || undefined,
      ...this.fetchContext(),
    });
    await this.host.secrets.store(key, JSON.stringify(registration));
    this.log('info', project, 'Registered a client with the authorization server (dynamic registration)');
    return { clientId: registration.clientId, clientSecret: registration.clientSecret, dynamic: true };
  }

  // -------------------------------------------------------------------------
  // Sign-in
  // -------------------------------------------------------------------------

  /**
   * The interactive flow. Validates configuration, discovers, opens the
   * browser, waits for the redirect, exchanges the code and stores the result.
   */
  async signIn(
    project: ResolvedProject,
    options: { signal?: AbortSignal; onProgress?: (message: string) => void } = {},
  ): Promise<SessionInfo> {
    const progress = options.onProgress ?? (() => undefined);
    try {
      const blocking = blockingIssues(project);
      if (blocking.length) {
        const missing = blocking.some((issue) => /missing|not set|No OAuth scopes/.test(issue.message));
        throw new OAuthError(
          `${project.displayName}: ${describeIssues(blocking)}`,
          undefined,
          missing ? 'missing_configuration' : 'invalid_configuration',
          'Run "MCP: Show Authentication Diagnostics" for the full list.',
        );
      }
      if (project.pendingApproval?.length) {
        throw new OAuthError(
          `${project.displayName} uses workspace settings that have not been approved: ${project.pendingApproval.join(', ')}`,
          undefined,
          'invalid_configuration',
          'Approve them when prompted, or move the configuration to user settings.',
        );
      }

      this.log('info', project, 'Sign-in started', { project: project.displayName });
      progress('Discovering the authorization server');
      const discovery = await this.discover(project);

      progress('Preparing the callback');
      const redirect = await this.prepareRedirect(project);
      try {
        const client = await this.clientFor(project, discovery, redirect.redirectUri);
        const pkce = createPkce();
        const state = createState();
        const nonce = discovery.scopes.includes('openid') ? createNonce() : undefined;

        const pending = this.pending.begin({
          projectId: project.id,
          state,
          callbackPath: redirect.callbackPath,
          timeoutMs: this.host.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        });

        const authorizationUrl = buildAuthorizationUrl({
          metadata: discovery.metadata,
          clientId: client.clientId,
          redirectUri: redirect.redirectUri,
          pkce,
          state,
          scope: discovery.scopes.join(' ') || undefined,
          resource: discovery.sendResource ? discovery.resource : undefined,
          nonce,
        });

        progress('Waiting for you to sign in in the browser');
        this.log('info', project, 'Browser authentication opened', {
          authorizationHost: tryParseUrl(discovery.metadata.authorizationEndpoint)?.host,
          callback: redirect.mode,
        });
        let opened = false;
        try {
          opened = await this.host.openBrowser(authorizationUrl);
        } catch {
          opened = false;
        }
        if (!opened) {
          pending.cancel(new OAuthError('The browser could not be opened', undefined, 'browser_unavailable'));
          throw new OAuthError(
            'The browser could not be opened for sign-in',
            undefined,
            'browser_unavailable',
            'Check that a default browser is configured.',
          );
        }

        const params = await this.awaitWithAbort(pending, options.signal);
        this.log('info', project, 'Callback received', { callback: redirect.mode });

        if (params.error) throw callbackError(params);
        this.log('info', project, 'OAuth state validated');

        // RFC 9207: the issuer in the response must be the one we sent the user to.
        if (params.iss !== undefined) {
          if (!issuersMatch(params.iss, discovery.issuer)) {
            throw new OAuthError(
              `The sign-in response came from ${params.iss}, not ${discovery.issuer}`,
              undefined,
              'issuer_mismatch',
              'This is the signature of an authorization-server mix-up; the response was discarded.',
            );
          }
        } else if (discovery.metadata.authorizationResponseIssParameterSupported) {
          throw new OAuthError(
            'The authorization server promises an "iss" parameter in its responses, but this one has none',
            undefined,
            'issuer_mismatch',
          );
        }
        if (!params.code) {
          throw new OAuthError('The sign-in response carried no authorization code', undefined, 'oauth_error');
        }

        progress('Exchanging the authorization code');
        const tokens = await exchangeAuthorizationCode({
          metadata: discovery.metadata,
          code: params.code,
          clientId: client.clientId,
          clientSecret: client.clientSecret,
          redirectUri: redirect.redirectUri,
          codeVerifier: pkce.verifier,
          resource: discovery.sendResource ? discovery.resource : undefined,
          ...this.fetchContext(),
        });
        this.log('info', project, 'Token exchange completed', {
          refreshable: !!tokens.refreshToken,
          idToken: !!tokens.idToken,
        });
        this.log('info', project, 'Token expiration calculated', {
          expiresAt: tokens.expiresAt ? new Date(tokens.expiresAt).toISOString() : 'not stated by the server',
        });

        const account = this.verifyTokens(project, discovery, client.clientId, tokens, nonce);
        const info = await this.persist(project, discovery, client, tokens, account);
        this.lastErrors.delete(project.id);
        this.log('info', project, 'Signed in', { account: info.accountLabel, scopes: info.scopes.join(' ') });
        return info;
      } finally {
        await redirect.dispose();
      }
    } catch (err) {
      this.recordError(project, err);
      throw err;
    }
  }

  private async awaitWithAbort(
    pending: { result: Promise<CallbackParams>; cancel(error: OAuthError): void },
    signal?: AbortSignal,
  ): Promise<CallbackParams> {
    if (!signal) return pending.result;
    if (signal.aborted) {
      pending.cancel(new OAuthError('Sign-in was cancelled', undefined, 'login_cancelled'));
      return pending.result;
    }
    const onAbort = () => pending.cancel(new OAuthError('Sign-in was cancelled', undefined, 'login_cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await pending.result;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  /** Checks what can be checked about the tokens, and works out who signed in. */
  private verifyTokens(
    project: ResolvedProject,
    discovery: DiscoveryResult,
    clientId: string,
    tokens: TokenSet,
    nonce: string | undefined,
  ): { id: string; label: string } {
    const errors: OAuthError[] = [];
    const warnings: string[] = [];

    let idClaims: JwtClaims | undefined;
    if (tokens.idToken) {
      const result = validateIdToken(tokens.idToken, { issuer: discovery.issuer, clientId, nonce, now: this.now() });
      idClaims = result.claims;
      errors.push(...result.errors);
    } else if (nonce) {
      warnings.push('An ID token was requested (openid scope) but none was returned.');
    }

    const access = inspectAccessToken(tokens.accessToken, {
      issuer: discovery.issuer,
      audiences: [discovery.resource, project.mcpUrl, project.oauth.resource],
      pinnedAudience: project.oauth.audience,
      strict: project.oauth.strict,
      now: this.now(),
    });
    errors.push(...access.errors);
    warnings.push(...access.warnings);

    const missing = missingScopes(discovery.scopes, tokens.scope);
    if (missing.length) {
      errors.push(
        new OAuthError(
          `The identity provider did not grant: ${missing.join(', ')}`,
          undefined,
          'scope_not_granted',
          'An administrator may need to consent to these scopes, or the account lacks access to them.',
        ),
      );
    }

    for (const warning of warnings) this.log('warn', project, warning);
    if (errors.length) {
      for (const extra of errors.slice(1)) this.log('error', project, extra.message, { code: extra.code });
      throw errors[0];
    }

    const account = accountFromClaims(idClaims, access.claims);
    return { id: account.id ?? 'default', label: account.label ?? project.displayName };
  }

  // -------------------------------------------------------------------------
  // Tokens for requests
  // -------------------------------------------------------------------------

  /**
   * A valid access token for a request to `requestUrl`, refreshed first if it
   * is close to expiry. Refuses to hand a project's token to any other origin.
   */
  async getAccessToken(project: ResolvedProject, requestUrl?: string): Promise<string> {
    if (requestUrl && !sameOrigin(requestUrl, project.mcpUrl)) {
      throw new OAuthError(
        `Refusing to send ${project.displayName}'s token to ${sanitizeUrl(requestUrl)}: it belongs to ${sanitizeUrl(project.mcpUrl)}`,
        undefined,
        'token_host_mismatch',
      );
    }
    const session = await this.loadSession(project);
    if (!session) throw new SignInRequiredError(project, 'not signed in');
    if (requestUrl && new URL(requestUrl).origin !== session.meta.mcpOrigin) {
      throw new OAuthError(
        `Refusing to send ${project.displayName}'s token to ${sanitizeUrl(requestUrl)}`,
        undefined,
        'token_host_mismatch',
      );
    }
    if (!needsRefresh({ accessToken: session.accessToken, expiresAt: session.meta.expiresAt, tokenType: session.meta.tokenType }, this.now())) {
      return session.accessToken;
    }
    this.log('info', project, 'Access token is expiring; refreshing');
    return this.refresh(project);
  }

  /**
   * One refresh per project at a time: concurrent callers share the same
   * promise, so ten parallel 401s cause one token request, not ten.
   */
  refresh(project: ResolvedProject): Promise<string> {
    const running = this.refreshing.get(project.id);
    if (running) return running;

    const task = (async () => {
      const session = await this.loadSession(project);
      if (!session) throw new SignInRequiredError(project, 'not signed in');
      if (!session.refreshToken) {
        await this.deleteSession(project.id);
        throw new SignInRequiredError(project, 'the access token expired and there is no refresh token');
      }
      try {
        const metadata: AuthorizationServerMetadata = {
          issuer: session.meta.issuer,
          authorizationEndpoint: session.meta.authorizationEndpoint,
          tokenEndpoint: session.meta.tokenEndpoint,
        };
        const clientSecret =
          !session.meta.dynamicClient && project.oauth.clientSecretSource
            ? await this.host.readClientSecret?.(project)
            : undefined;
        const tokens = await refreshAccessToken({
          metadata,
          tokens: {
            accessToken: session.accessToken,
            refreshToken: session.refreshToken,
            expiresAt: session.meta.expiresAt,
            scope: session.meta.grantedScope,
            tokenType: session.meta.tokenType,
          },
          clientId: session.meta.clientId,
          clientSecret,
          resource: session.meta.resource,
          scope: session.meta.requestedScopes.join(' ') || undefined,
          ...this.fetchContext(),
        });

        const inspection = inspectAccessToken(tokens.accessToken, {
          issuer: session.meta.issuer,
          audiences: session.meta.audiences,
          pinnedAudience: project.oauth.audience,
          strict: project.oauth.strict,
          now: this.now(),
        });
        if (inspection.errors.length) throw inspection.errors[0];

        const rotated = !!tokens.refreshToken && tokens.refreshToken !== session.refreshToken;
        const meta: TokenMetadata = {
          ...session.meta,
          grantedScope: tokens.scope,
          tokenType: tokens.tokenType,
          expiresAt: tokens.expiresAt,
        };
        await this.host.secrets.store(this.secretKey(project.id, session.info.accountKey, 'accessToken'), tokens.accessToken);
        if (tokens.refreshToken) {
          await this.host.secrets.store(this.secretKey(project.id, session.info.accountKey, 'refreshToken'), tokens.refreshToken);
        }
        await this.host.secrets.store(this.secretKey(project.id, session.info.accountKey, 'tokenMetadata'), JSON.stringify(meta));

        const index = this.index();
        const info: SessionInfo = {
          ...session.info,
          expiresAt: tokens.expiresAt,
          hasRefreshToken: !!(tokens.refreshToken ?? session.refreshToken),
          scopes: parseScopes(tokens.scope ?? session.info.scopes),
        };
        index[project.id] = info;
        await this.host.state.update(INDEX_KEY, index);
        this.cache.set(project.id, {
          info,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken ?? session.refreshToken,
          meta,
        });
        this.changes.fire({ projectId: project.id, kind: 'changed', session: info });
        this.log('info', project, 'Access token refreshed', {
          refreshTokenRotated: rotated,
          expiresAt: tokens.expiresAt ? new Date(tokens.expiresAt).toISOString() : 'not stated',
        });
        return tokens.accessToken;
      } catch (err) {
        const failure = err instanceof OAuthError ? err : new OAuthError(errorText(err), err);
        // A network blip is not a revoked grant: keep the session for next time.
        if (failure.code === 'network_error' || failure.code === 'certificate_error') {
          this.recordError(project, failure);
          throw failure;
        }
        await this.deleteSession(project.id);
        this.log('warn', project, 'Token refresh failed; the session was cleared and sign-in is required', {
          reason: failure.message,
        });
        const signIn = new SignInRequiredError(project, `token refresh failed (${failure.message})`, failure);
        this.recordError(project, signIn);
        throw signIn;
      }
    })().finally(() => this.refreshing.delete(project.id));

    this.refreshing.set(project.id, task);
    return task;
  }

  /**
   * Called when the MCP server rejects a request with 401. Returns true when the
   * request should be retried once: either another request already refreshed
   * the token, or this one just did. Never loops - the transport retries once.
   */
  async handleUnauthorized(project: ResolvedProject, sentAuthorization?: string): Promise<boolean> {
    const session = await this.loadSession(project);
    if (!session) return false;
    if (sentAuthorization && !secretsEqual(sentAuthorization, `Bearer ${session.accessToken}`)) {
      this.log('info', project, 'Request was rejected with an older token; retrying with the current one');
      return true;
    }
    this.log('warn', project, 'MCP server rejected the access token (HTTP 401); refreshing once');
    try {
      await this.refresh(project);
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Sign-out and diagnostics
  // -------------------------------------------------------------------------

  async signOut(project: Pick<ResolvedProject, 'id' | 'displayName'>): Promise<boolean> {
    this.pending.cancelProject(project.id, new OAuthError('Signed out', undefined, 'login_cancelled'));
    const had = !!this.index()[project.id];
    await this.deleteSession(project.id);
    // The single-key format used before projects existed.
    await this.host.secrets.delete(`mcplab.oauth.tokens.${project.id}`);
    this.lastDiscovery.delete(project.id);
    this.log('info', project, had ? 'Signed out' : 'Sign-out requested; no session was stored');
    return had;
  }

  private recordError(project: Pick<ResolvedProject, 'id'>, err: unknown): void {
    const failure = err instanceof OAuthError ? err : undefined;
    this.lastErrors.set(project.id, {
      code: failure?.code ?? 'error',
      message: redact(errorText(err)),
      at: this.now(),
    });
    this.log('error', project, errorText(err), failure ? { code: failure.code, hint: failure.hint } : undefined);
  }

  /** Everything that helps explain a failed sign-in, with nothing secret in it. */
  async diagnostics(project: ResolvedProject): Promise<Record<string, unknown>> {
    const discovery = this.lastDiscovery.get(project.id);
    const session = this.session(project.id);
    let redirect: { mode: string; redirectUri: string } | { error: string };
    try {
      const described = await this.describeRedirect(project);
      redirect = { mode: described.mode, redirectUri: sanitizeUrl(described.redirectUri) || described.redirectUri };
    } catch (err) {
      redirect = { error: errorText(err) };
    }
    return {
      project: {
        id: project.id,
        name: project.displayName,
        origin: project.origin,
        mcpUrl: sanitizeUrl(project.mcpUrl),
        resource: sanitizeUrl(project.oauth.resource),
        resourceConfigured: project.oauth.resourceConfigured,
        clientId: project.oauth.clientId ?? (project.origin === 'adhoc' ? '(dynamic registration)' : '(missing)'),
        clientSecret: project.oauth.clientSecretSource
          ? project.oauth.clientSecretSource.kind === 'environment'
            ? `from environment variable ${project.oauth.clientSecretSource.variable}`
            : 'from secure storage'
          : 'none (public client)',
        scopes: project.oauth.scopes,
        authority: project.oauth.authority,
        discoveryUrl: project.oauth.discoveryUrl ? sanitizeUrl(project.oauth.discoveryUrl) : undefined,
        protectedResourceMetadataUrl: project.oauth.protectedResourceMetadataUrl
          ? sanitizeUrl(project.oauth.protectedResourceMetadataUrl)
          : undefined,
        callbackMode: project.oauth.callbackMode,
        resourceParameter: project.oauth.resourceParameter,
        strict: project.oauth.strict,
        trustedHosts: project.oauth.trustedHosts,
        valueSources: project.sources,
        environmentReferences: project.environmentReferences,
        pendingWorkspaceApproval: project.pendingApproval,
        issues: project.issues.map((issue) => ({
          severity: issue.severity,
          message: issue.message,
          set: issue.configKeys,
        })),
      },
      redirect,
      discovery: discovery
        ? {
            issuer: discovery.issuer,
            authorizationEndpoint: sanitizeUrl(discovery.metadata.authorizationEndpoint),
            tokenEndpoint: sanitizeUrl(discovery.metadata.tokenEndpoint),
            metadataUrl: sanitizeUrl(discovery.metadata.metadataUrl),
            protectedResourceMetadata: sanitizeUrl(discovery.protectedResource?.metadataUrl),
            resource: sanitizeUrl(discovery.resource),
            resourceParameterSent: discovery.sendResource,
            pkceAdvertised: discovery.metadata.codeChallengeMethodsSupported ?? 'not advertised',
            issParameterSupported: discovery.metadata.authorizationResponseIssParameterSupported ?? false,
            steps: discovery.steps,
            warnings: discovery.warnings,
          }
        : 'not run in this session',
      session: session
        ? {
            account: session.accountLabel,
            issuer: session.issuer,
            scopes: session.scopes,
            expiresAt: session.expiresAt ? new Date(session.expiresAt).toISOString() : 'not stated',
            expired: session.expiresAt !== undefined && session.expiresAt <= this.now(),
            refreshable: session.hasRefreshToken,
            signedInAt: new Date(session.signedInAt).toISOString(),
            boundToCurrentConfiguration: session.bindingKey === bindingKey(project),
          }
        : 'not signed in',
      lastError: this.lastErrors.get(project.id) ?? 'none',
      signInInProgress: this.pending.hasPending(project.id),
    };
  }

  dispose(): void {
    this.pending.dispose();
    this.changes.dispose();
  }
}

/** Walks an error's causes for a 401 from the MCP endpoint or a sign-in requirement. */
export function needsInteractiveSignIn(err: unknown, depth = 0): boolean {
  if (!err || depth > 6) return false;
  if (err instanceof OAuthError && err.code === 'sign_in_required') return true;
  const candidate = err as { status?: unknown; cause?: unknown; data?: unknown };
  if (candidate.status === 401) return true;
  return needsInteractiveSignIn(candidate.cause, depth + 1) || needsInteractiveSignIn(candidate.data, depth + 1);
}
