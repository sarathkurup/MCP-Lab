import * as vscode from 'vscode';
import type { SessionChange, SessionInfo } from '../../core/oauthSession';
import type { McpLab } from '../McpLab';

export const AUTH_PROVIDER_ID = 'mcplab';

/**
 * MCP Lab's sign-ins, as a VS Code authentication provider.
 *
 * This puts each signed-in MCP project in the Accounts menu, where it can be
 * seen and signed out of like any other account. Each project is one session,
 * labelled with the account and the project it belongs to. The refresh token
 * is never exposed - only the current access token, which VS Code hands to
 * another extension only after the user consents.
 */
export class McpLabAuthenticationProvider implements vscode.AuthenticationProvider, vscode.Disposable {
  private readonly changed =
    new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  readonly onDidChangeSessions = this.changed.event;
  private readonly subscription: { dispose(): void };

  constructor(private readonly lab: McpLab) {
    this.subscription = lab.oauth.onDidChangeSessions((change) => this.relay(change));
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }

  private toSession(info: SessionInfo, accessToken: string): vscode.AuthenticationSession {
    const project = this.lab.store.get(info.projectId);
    return {
      id: info.sessionId,
      accessToken,
      account: {
        id: info.accountKey,
        label: `${info.accountLabel} (${project?.name ?? info.projectId})`,
      },
      scopes: info.scopes,
    };
  }

  private relay(change: SessionChange): void {
    if (!change.session) return;
    // Removed sessions carry no token; nobody may use them any more anyway.
    const session = this.toSession(change.session, '');
    this.changed.fire({
      added: change.kind === 'added' ? [session] : [],
      removed: change.kind === 'removed' ? [session] : [],
      changed: change.kind === 'changed' ? [session] : [],
    });
  }

  async getSessions(
    scopes?: readonly string[],
  ): Promise<vscode.AuthenticationSession[]> {
    const wanted = (scopes ?? []).filter((scope) => !['offline_access', 'openid', 'profile', 'email'].includes(scope));
    const sessions: vscode.AuthenticationSession[] = [];
    for (const info of this.lab.oauth.manager.sessions()) {
      if (!wanted.every((scope) => info.scopes.includes(scope))) continue;
      const config = this.lab.store.get(info.projectId);
      if (!config) continue;
      try {
        // Refreshes first when close to expiry, so a consumer never gets a dead token.
        sessions.push(this.toSession(info, await this.lab.oauth.accessToken(config)));
      } catch {
        // A session that can no longer produce a token is not offered.
      }
    }
    return sessions;
  }

  async createSession(): Promise<vscode.AuthenticationSession> {
    const projectId = await this.lab.pickProject('Sign in to which MCP project?');
    if (!projectId) {
      throw new Error('Sign-in cancelled');
    }
    const config = this.lab.store.get(projectId);
    if (!config) {
      throw new Error(`Unknown MCP project "${projectId}"`);
    }
    const info = await this.lab.oauth.signIn(config);
    return this.toSession(info, await this.lab.oauth.accessToken(config));
  }

  async removeSession(sessionId: string): Promise<void> {
    const info = this.lab.oauth.manager.sessions().find((session) => session.sessionId === sessionId);
    if (!info) return;
    const config = this.lab.store.get(info.projectId);
    await this.lab.manager.disconnect(info.projectId);
    if (config) await this.lab.oauth.signOut(config);
  }
}
