import * as vscode from 'vscode';
import type { ServerConfig } from '../../core/config';
import type { LogStore } from '../../core/logging';
import {
  buildAuthorizationUrl,
  createPkce,
  createState,
  discoverAuthorizationServer,
  discoverProtectedResource,
  exchangeAuthorizationCode,
  needsRefresh,
  parseWwwAuthenticate,
  refreshAccessToken,
  registerClient,
  type AuthorizationServerMetadata,
  type ClientRegistration,
  type TokenSet,
} from '../../core/oauth';

/**
 * The host half of OAuth: the parts core cannot do because they need an editor -
 * opening a browser, catching the redirect, and keeping tokens somewhere they
 * survive a restart.
 *
 * Everything persisted here goes to SecretStorage, which is the OS keychain.
 * That is what makes a sign-in outlive VS Code closing and the machine
 * rebooting: on the next call the access token is either still valid or is
 * refreshed silently from the stored refresh token, and the user sees nothing.
 */

const TOKEN_PREFIX = 'mcplab.oauth.tokens.';
const CLIENT_PREFIX = 'mcplab.oauth.client.';
/** A browser round trip that has not come back by now is not coming back. */
const REDIRECT_TIMEOUT_MS = 5 * 60_000;

interface StoredSession {
  tokens: TokenSet;
  metadata: AuthorizationServerMetadata;
  clientId: string;
  clientSecret?: string;
  resource?: string;
}

interface PendingFlow {
  resolve: (code: string) => void;
  reject: (err: Error) => void;
}

export class OAuthService implements vscode.Disposable {
  private readonly pending = new Map<string, PendingFlow>();
  private readonly disposables: vscode.Disposable[] = [];
  /** Serialises refreshes so ten parallel calls cause one token request. */
  private readonly inFlight = new Map<string, Promise<string | undefined>>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logs: LogStore,
  ) {
    this.disposables.push(
      vscode.window.registerUriHandler({
        handleUri: (uri) => this.handleRedirect(uri),
      }),
    );
  }

  dispose(): void {
    for (const item of this.disposables) item.dispose();
    for (const flow of this.pending.values()) {
      flow.reject(new Error('Extension shut down during sign-in'));
    }
    this.pending.clear();
  }

  private get redirectUri(): string {
    // VS Code routes vscode://<publisher>.<name>/... back to this extension.
    return `${vscode.env.uriScheme}://${this.context.extension.id}/auth-callback`;
  }

  // -------------------------------------------------------------------------
  // Token access
  // -------------------------------------------------------------------------

  /**
   * A usable access token, refreshed if needed. Returns undefined when the user
   * has never signed in or the refresh token is spent - the caller then decides
   * whether to prompt, because a background reconnect should not open a browser.
   */
  async accessToken(serverId: string): Promise<string | undefined> {
    const existing = this.inFlight.get(serverId);
    if (existing) return existing;

    const run = this.resolveToken(serverId).finally(() => this.inFlight.delete(serverId));
    this.inFlight.set(serverId, run);
    return run;
  }

  private async resolveToken(serverId: string): Promise<string | undefined> {
    const session = await this.readSession(serverId);
    if (!session) return undefined;

    if (!needsRefresh(session.tokens)) {
      return session.tokens.accessToken;
    }

    if (!session.tokens.refreshToken) {
      this.logs.log('warn', 'OAuth token expired and there is no refresh token', { serverId });
      return undefined;
    }

    try {
      const tokens = await refreshAccessToken({
        metadata: session.metadata,
        tokens: session.tokens,
        clientId: session.clientId,
        clientSecret: session.clientSecret,
        resource: session.resource,
      });
      await this.writeSession(serverId, { ...session, tokens });
      this.logs.log('info', 'OAuth access token refreshed', { serverId });
      return tokens.accessToken;
    } catch (err) {
      // A refused refresh means the grant is gone; drop it so the next call
      // prompts for a fresh sign-in rather than retrying forever.
      this.logs.log('warn', 'OAuth refresh failed; sign-in required', {
        serverId,
        detail: errorText(err),
      });
      await this.context.secrets.delete(TOKEN_PREFIX + serverId);
      return undefined;
    }
  }

  async isSignedIn(serverId: string): Promise<boolean> {
    return (await this.readSession(serverId)) !== undefined;
  }

  async signOut(serverId: string): Promise<void> {
    await this.context.secrets.delete(TOKEN_PREFIX + serverId);
    this.logs.log('info', 'Signed out', { serverId });
  }

  // -------------------------------------------------------------------------
  // Interactive sign-in
  // -------------------------------------------------------------------------

  /**
   * The full chain: discover where to authenticate, register if this is the
   * first time, open a browser, wait for the redirect, exchange the code.
   *
   * `challengeHeader` is the `WWW-Authenticate` from a 401, when one provoked
   * this. It names the metadata document directly, which saves guessing.
   */
  async signIn(config: ServerConfig, challengeHeader?: string): Promise<void> {
    if (!config.url) {
      throw new Error('Only HTTP servers can use OAuth; this one is stdio.');
    }

    const metadataUrl = challengeHeader
      ? parseWwwAuthenticate(challengeHeader).resourceMetadata
      : undefined;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Signing in to ${config.name}` },
      async (progress) => {
        progress.report({ message: 'Discovering the authorization server' });
        const resource = await discoverProtectedResource(config.url!, { metadataUrl });
        const issuer = resource.authorizationServers[0];
        const metadata = await discoverAuthorizationServer(issuer);

        progress.report({ message: 'Preparing the client' });
        const client = await this.clientFor(metadata, resource.scopesSupported?.join(' '));

        const pkce = createPkce();
        const state = createState();
        const authorizationUrl = buildAuthorizationUrl({
          metadata,
          clientId: client.clientId,
          redirectUri: this.redirectUri,
          pkce,
          state,
          scope: resource.scopesSupported?.join(' '),
          resource: resource.resource ?? config.url,
        });

        progress.report({ message: 'Waiting for the browser' });
        const waiting = this.waitForRedirect(state);
        const opened = await vscode.env.openExternal(vscode.Uri.parse(authorizationUrl));
        if (!opened) {
          this.pending.delete(state);
          throw new Error('Could not open a browser for the sign-in');
        }

        const code = await waiting;

        progress.report({ message: 'Exchanging the code' });
        const tokens = await exchangeAuthorizationCode({
          metadata,
          code,
          clientId: client.clientId,
          clientSecret: client.clientSecret,
          redirectUri: this.redirectUri,
          codeVerifier: pkce.verifier,
          resource: resource.resource ?? config.url,
        });

        await this.writeSession(config.id, {
          tokens,
          metadata,
          clientId: client.clientId,
          clientSecret: client.clientSecret,
          resource: resource.resource ?? config.url,
        });
        this.logs.log('info', 'Signed in', {
          serverId: config.id,
          detail: {
            issuer: metadata.issuer,
            expiresAt: tokens.expiresAt ? new Date(tokens.expiresAt).toISOString() : 'not stated',
            refreshable: Boolean(tokens.refreshToken),
          },
        });
      },
    );
  }

  /**
   * A client id for this issuer, registering one if we have none. Registrations
   * are keyed by issuer rather than by server, because several MCP servers
   * behind one authorization server can share it.
   */
  private async clientFor(
    metadata: AuthorizationServerMetadata,
    scope?: string,
  ): Promise<ClientRegistration> {
    const key = CLIENT_PREFIX + metadata.issuer;
    const stored = await this.context.secrets.get(key);
    if (stored) {
      const parsed = safeParse<ClientRegistration>(stored);
      if (parsed?.clientId) {
        const expired =
          parsed.clientSecretExpiresAt !== undefined && parsed.clientSecretExpiresAt <= Date.now();
        if (!expired) return parsed;
      }
    }

    if (!metadata.registrationEndpoint) {
      throw new Error(
        `${metadata.issuer} does not support dynamic client registration. Register MCP Lab ` +
          `manually and add the client id to the server's auth settings.`,
      );
    }

    const registration = await registerClient(metadata.registrationEndpoint, {
      clientName: 'MCP Lab',
      redirectUri: this.redirectUri,
      scope,
    });
    await this.context.secrets.store(key, JSON.stringify(registration));
    return registration;
  }

  private waitForRedirect(state: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(state);
        reject(new Error('Timed out waiting for the browser to come back'));
      }, REDIRECT_TIMEOUT_MS);

      this.pending.set(state, {
        resolve: (code) => {
          clearTimeout(timer);
          this.pending.delete(state);
          resolve(code);
        },
        reject: (err) => {
          clearTimeout(timer);
          this.pending.delete(state);
          reject(err);
        },
      });
    });
  }

  private handleRedirect(uri: vscode.Uri): void {
    const params = new URLSearchParams(uri.query);
    const state = params.get('state');
    if (!state) return;

    // An unknown state is either a stale redirect or a forged one. Either way
    // there is no flow to complete, so it is dropped rather than guessed at.
    const flow = this.pending.get(state);
    if (!flow) return;

    const error = params.get('error');
    if (error) {
      flow.reject(new Error(params.get('error_description') ?? error));
      return;
    }

    const code = params.get('code');
    if (!code) {
      flow.reject(new Error('The redirect carried no authorization code'));
      return;
    }
    flow.resolve(code);
  }

  // -------------------------------------------------------------------------

  private async readSession(serverId: string): Promise<StoredSession | undefined> {
    const raw = await this.context.secrets.get(TOKEN_PREFIX + serverId);
    return raw ? safeParse<StoredSession>(raw) : undefined;
  }

  private async writeSession(serverId: string, session: StoredSession): Promise<void> {
    await this.context.secrets.store(TOKEN_PREFIX + serverId, JSON.stringify(session));
  }
}

function safeParse<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
