import * as vscode from 'vscode';
import { AuthProvider, type AuthConfig } from '../../core/auth';
import { deriveServerId, validateServerConfig, type ServerConfig } from '../../core/config';

const STATE_KEY = 'mcpWorkbench.servers.v1';
const SECRET_PREFIX = 'mcpWorkbench.auth.';

/**
 * Persistence for server definitions. Two sources are merged: servers the user
 * added through the UI (global state) and servers declared in workspace
 * settings. Credentials live in SecretStorage and never touch either.
 */
export class ServerStore {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly authProviders = new Map<string, AuthProvider>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** UI-added servers plus settings-declared ones, settings losing on id clash. */
  list(): ServerConfig[] {
    const user = this.listUserServers();
    const ids = new Set(user.map((s) => s.id));
    const fromSettings = this.listSettingsServers().filter((s) => !ids.has(s.id));
    return [...user, ...fromSettings].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(serverId: string): ServerConfig | undefined {
    return this.list().find((s) => s.id === serverId);
  }

  private listUserServers(): ServerConfig[] {
    const stored = this.context.globalState.get<ServerConfig[]>(STATE_KEY, []);
    return stored.map((s) => ({ ...s, source: 'user' as const }));
  }

  private listSettingsServers(): ServerConfig[] {
    const raw = vscode.workspace
      .getConfiguration('mcpWorkbench')
      .get<Partial<ServerConfig>[]>('servers', []);

    const configs: ServerConfig[] = [];
    const taken = new Set<string>();
    for (const entry of raw) {
      const issues = validateServerConfig(entry);
      if (issues.length > 0) {
        continue;
      }
      const id = deriveServerId(entry.name!, taken);
      taken.add(id);
      configs.push({ ...(entry as ServerConfig), id, source: 'settings' });
    }
    return configs;
  }

  async add(config: Omit<ServerConfig, 'id' | 'source'>): Promise<ServerConfig> {
    const taken = this.list().map((s) => s.id);
    const created: ServerConfig = {
      ...config,
      id: deriveServerId(config.name, taken),
      source: 'user',
    };
    const user = this.listUserServers();
    await this.context.globalState.update(STATE_KEY, [...user, stripSource(created)]);
    this.changed.fire();
    return created;
  }

  async update(config: ServerConfig): Promise<void> {
    const user = this.listUserServers();
    const index = user.findIndex((s) => s.id === config.id);
    if (index === -1) {
      throw new Error('Only servers added in Workbench can be edited here.');
    }
    user[index] = config;
    await this.context.globalState.update(STATE_KEY, user.map(stripSource));
    this.changed.fire();
  }

  async remove(serverId: string): Promise<void> {
    const user = this.listUserServers();
    const next = user.filter((s) => s.id !== serverId);
    if (next.length === user.length) {
      throw new Error(
        'This server is declared in settings. Remove it from "mcpWorkbench.servers" instead.',
      );
    }
    await this.context.globalState.update(STATE_KEY, next.map(stripSource));
    await this.clearAuthToken(serverId);
    this.changed.fire();
  }

  // -------------------------------------------------------------------------
  // Secrets
  // -------------------------------------------------------------------------

  async getAuthToken(serverId: string): Promise<string | undefined> {
    return this.context.secrets.get(SECRET_PREFIX + serverId);
  }

  async setAuthToken(serverId: string, token: string): Promise<void> {
    await this.context.secrets.store(SECRET_PREFIX + serverId, token);
    this.invalidateAuth(serverId);
  }

  async clearAuthToken(serverId: string): Promise<void> {
    await this.context.secrets.delete(SECRET_PREFIX + serverId);
    this.invalidateAuth(serverId);
  }

  /**
   * Headers for one request. Providers are cached per server so an OAuth token
   * is minted once and reused until it is close to expiring.
   */
  async authHeaders(config: ServerConfig): Promise<Record<string, string>> {
    const auth: AuthConfig = config.auth ?? { kind: 'bearer' };
    const cacheKey = `${config.id}:${JSON.stringify(auth)}`;

    let provider = this.authProviders.get(cacheKey);
    if (!provider) {
      provider = new AuthProvider(auth, {
        resolveSecret: () => this.getAuthToken(config.id),
      });
      // Only one provider per server: a changed auth shape replaces the old one.
      for (const key of [...this.authProviders.keys()]) {
        if (key.startsWith(`${config.id}:`)) {
          this.authProviders.delete(key);
        }
      }
      this.authProviders.set(cacheKey, provider);
    }

    try {
      return await provider.headers();
    } catch (err) {
      // An auth failure must surface as a connection error, not a silent 401.
      throw new Error(
        `Authentication failed for "${config.name}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Drops any cached token, e.g. after the credential is changed. */
  invalidateAuth(serverId: string): void {
    for (const [key, provider] of this.authProviders) {
      if (key.startsWith(`${serverId}:`)) {
        provider.invalidate();
        this.authProviders.delete(key);
      }
    }
  }

  dispose(): void {
    this.changed.dispose();
  }
}

function stripSource(config: ServerConfig): ServerConfig {
  const { source: _source, ...rest } = config;
  return rest as ServerConfig;
}
