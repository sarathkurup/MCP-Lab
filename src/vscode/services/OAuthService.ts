import * as vscode from 'vscode';
import type { ServerConfig } from '../../core/config';
import type { LogStore } from '../../core/logging';
import { findOAuthError, sanitizeUrl } from '../../core/oauth';
import { CALLBACK_PATH } from '../../core/oauthCallback';
import {
  OAuthSessionManager,
  type AuthLogLevel,
  type SessionChange,
  type SessionInfo,
} from '../../core/oauthSession';
import { adhocProject, type ResolvedProject } from '../../core/projects';
import type { UnauthorizedContext } from '../../core/transport/StreamableHttpTransport';

/**
 * The editor half of OAuth. Everything protocol-shaped - discovery, PKCE,
 * state, the code exchange, refresh, isolation between projects - lives in
 * core's OAuthSessionManager and is tested there against real HTTP servers.
 * This class supplies only what an editor alone can:
 *
 *   - SecretStorage (the OS keychain) for tokens, so a sign-in survives VS Code
 *     closing and the machine rebooting
 *   - the browser, through openExternal
 *   - the way back, through the URI handler and asExternalUri - which is what
 *     lets the callback reach the extension host in Remote SSH, WSL, dev
 *     containers and Codespaces, where the browser is on another machine
 *   - consent prompts and the "MCP Lab: Auth" output channel
 */

const SECRET_INDEX_KEY = 'mcplab.oauth.clientSecretProjects';

export interface AuthTreeStatus {
  signedIn: boolean;
  account?: string;
  expiresAt?: number;
  refreshable?: boolean;
}

export class OAuthService implements vscode.Disposable {
  readonly manager: OAuthSessionManager;
  private readonly channel: vscode.OutputChannel;
  private readonly disposables: vscode.Disposable[] = [];

  readonly onDidChangeSessions: (listener: (change: SessionChange) => void) => { dispose(): void };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logs: LogStore,
  ) {
    this.channel = vscode.window.createOutputChannel('MCP Lab: Auth');
    this.disposables.push(this.channel);

    this.manager = new OAuthSessionManager({
      secrets: {
        get: async (key) => context.secrets.get(key),
        store: async (key, value) => context.secrets.store(key, value),
        delete: async (key) => context.secrets.delete(key),
      },
      state: {
        get: <T>(key: string) => context.globalState.get<T>(key),
        update: async (key, value) => context.globalState.update(key, value),
      },
      logger: { log: (level, projectId, message, detail) => this.write(level, projectId, message, detail) },
      openBrowser: async (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
      editorRedirectUri: () => this.editorRedirectUri(),
      externalizeLoopback: async (url) => (await vscode.env.asExternalUri(vscode.Uri.parse(url))).toString(true),
      unsupportedReason: (mode) => this.unsupportedReason(mode),
      approveAuthorizationServer: (project, issuer) => this.approveIssuer(project, issuer),
      readClientSecret: (project) => this.readClientSecret(project),
      clientName: 'MCP Lab',
    });
    this.onDidChangeSessions = this.manager.onDidChangeSessions;

    this.disposables.push(
      vscode.window.registerUriHandler({
        handleUri: (uri) => {
          this.manager.deliverCallback(uri.path, uri.query);
        },
      }),
    );
  }

  dispose(): void {
    this.manager.dispose();
    for (const item of this.disposables) item.dispose();
  }

  showLog(): void {
    this.channel.show(true);
  }

  /**
   * Writes the redirect URI this editor will use, so whoever registers the
   * client with the identity provider can read it straight off the channel.
   */
  async announceRedirectUri(projectCount: number): Promise<void> {
    if (projectCount === 0) return;
    const uri = await this.editorRedirectUri();
    this.write(
      'info',
      undefined,
      uri
        ? `Redirect URI for sign-in in this editor: ${sanitizeUrl(uri) || uri} (register it with the identity provider; projects using "callbackMode": "loopback" use http://127.0.0.1:<port>/auth/callback instead)`
        : 'This editor has no URI-handler redirect; sign-in will use a loopback callback on 127.0.0.1.',
      { projects: projectCount, ...this.environment() },
    );
  }

  // -------------------------------------------------------------------------
  // Logging: one dedicated channel, mirrored into the panel's log view
  // -------------------------------------------------------------------------

  private write(level: AuthLogLevel, projectId: string | undefined, message: string, detail?: Record<string, unknown>): void {
    if (level === 'debug' && !vscode.workspace.getConfiguration('mcplab').get<boolean>('debugLogging', false)) {
      return;
    }
    const time = new Date().toISOString().slice(11, 23);
    const scope = projectId ? ` [${projectId}]` : '';
    const extra = detail && Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : '';
    this.channel.appendLine(`${time} ${level.toUpperCase().padEnd(5)}${scope} ${message}${extra}`);
    this.logs.log(level, `auth: ${message}`, { serverId: projectId, source: 'mcplab', detail });
  }

  // -------------------------------------------------------------------------
  // Environment
  // -------------------------------------------------------------------------

  /** vscode://<publisher>.<name>/auth/callback, made reachable from the browser. */
  async editorRedirectUri(): Promise<string | undefined> {
    const local = vscode.Uri.parse(`${vscode.env.uriScheme}://${this.context.extension.id}${CALLBACK_PATH}`);
    try {
      return (await vscode.env.asExternalUri(local)).toString(true);
    } catch {
      return undefined;
    }
  }

  private unsupportedReason(mode: 'uri' | 'loopback'): string | undefined {
    if (mode === 'loopback' && vscode.env.uiKind === vscode.UIKind.Web) {
      return (
        'A loopback sign-in callback cannot work in a browser-based editor, because the browser ' +
        'cannot reach a listener on the extension host. Use "oauth.callbackMode": "uri".'
      );
    }
    return undefined;
  }

  environment(): Record<string, unknown> {
    return {
      editor: vscode.env.appName,
      uriScheme: vscode.env.uriScheme,
      uiKind: vscode.env.uiKind === vscode.UIKind.Web ? 'web' : 'desktop',
      remote: vscode.env.remoteName ?? 'local',
      extensionId: this.context.extension.id,
      extensionHostPlatform: process.platform,
    };
  }

  // -------------------------------------------------------------------------
  // Consent and secrets
  // -------------------------------------------------------------------------

  private async approveIssuer(project: ResolvedProject, issuer: string): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(
      `${project.displayName} wants you to sign in at ${sanitizeUrl(issuer)}.`,
      {
        modal: true,
        detail:
          'The MCP server named this identity provider, but your configuration does not. ' +
          'Only continue if you recognise it. To skip this question, set oauth.authority for the project.',
      },
      'Trust and Sign In',
    );
    return choice === 'Trust and Sign In';
  }

  private async readClientSecret(project: ResolvedProject): Promise<string | undefined> {
    const source = project.oauth.clientSecretSource;
    if (!source) return undefined;
    if (source.kind === 'environment') return process.env[source.variable] || undefined;
    return this.context.secrets.get(this.clientSecretKey(project.id));
  }

  private clientSecretKey(projectId: string): string {
    return `mcplab.oauth.${projectId}.clientSecret`;
  }

  /** Project ids with a client secret in secure storage. Non-secret, kept in state. */
  secureSecretProjects(): Set<string> {
    return new Set(this.context.globalState.get<string[]>(SECRET_INDEX_KEY, []));
  }

  async storeClientSecret(projectId: string, secret: string | undefined): Promise<void> {
    const ids = this.secureSecretProjects();
    if (secret) {
      await this.context.secrets.store(this.clientSecretKey(projectId), secret);
      ids.add(projectId);
    } else {
      await this.context.secrets.delete(this.clientSecretKey(projectId));
      ids.delete(projectId);
    }
    await this.context.globalState.update(SECRET_INDEX_KEY, [...ids]);
  }

  // -------------------------------------------------------------------------
  // What the rest of the extension calls
  // -------------------------------------------------------------------------

  /** The project behind a server definition; a hand-added server gets an ad-hoc one. */
  projectFor(config: ServerConfig): ResolvedProject {
    return config.project ?? adhocProject(config);
  }

  /** A valid token for a request to `requestUrl`, refreshed first when needed. */
  accessToken(config: ServerConfig, requestUrl?: string): Promise<string> {
    return this.manager.getAccessToken(this.projectFor(config), requestUrl);
  }

  /** A 401 from an OAuth server: refresh once and retry, never more. */
  async handleUnauthorized(config: ServerConfig, context: UnauthorizedContext): Promise<boolean> {
    if (config.auth?.kind !== 'oauth') return false;
    return this.manager.handleUnauthorized(this.projectFor(config), context.authorization);
  }

  session(serverId: string): SessionInfo | undefined {
    return this.manager.session(serverId);
  }

  status(serverId: string): AuthTreeStatus {
    const session = this.manager.session(serverId);
    return session
      ? { signedIn: true, account: session.accountLabel, expiresAt: session.expiresAt, refreshable: session.hasRefreshToken }
      : { signedIn: false };
  }

  /** The interactive sign-in, with a cancellable notification. */
  async signIn(config: ServerConfig): Promise<SessionInfo> {
    const project = this.projectFor(config);
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Signing in to ${project.displayName}`,
        cancellable: true,
      },
      async (progress, token) => {
        const controller = new AbortController();
        const subscription = token.onCancellationRequested(() => controller.abort());
        try {
          return await this.manager.signIn(project, {
            signal: controller.signal,
            onProgress: (message) => progress.report({ message }),
          });
        } finally {
          subscription.dispose();
        }
      },
    );
  }

  signOut(config: ServerConfig): Promise<boolean> {
    return this.manager.signOut(this.projectFor(config));
  }

  async diagnostics(config: ServerConfig): Promise<Record<string, unknown>> {
    const project = this.projectFor(config);
    return {
      ...(await this.manager.diagnostics(project)),
      environment: this.environment(),
    };
  }
}

/**
 * A message for a person: the error, then what to do about it. Looks through
 * the cause chain, because an auth failure usually arrives wrapped in the MCP
 * client's own error.
 */
export function explainAuthError(err: unknown): string {
  const error = findOAuthError(err);
  const message = error?.message ?? (err instanceof Error ? err.message : String(err));
  return error?.hint ? `${message.replace(/\.$/, '')}. ${error.hint}` : message;
}
