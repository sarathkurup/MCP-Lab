import * as vscode from 'vscode';
import { AuthProvider, type AuthConfig } from '../../core/auth';
import { deriveServerId, validateServerConfig, type ServerConfig } from '../../core/config';
import { sanitizeUrl } from '../../core/oauth';
import {
  SENSITIVE_SETTING_KEYS,
  findWorkspaceOverrides,
  projectToServerConfig,
  resolveProjects,
  type OAuthInput,
  type ProjectResolution,
} from '../../core/projects';

const STATE_KEY = 'mcplab.servers.v1';
const SECRET_PREFIX = 'mcplab.auth.';
const APPROVALS_KEY = 'mcplab.workspaceApprovals';

const OAUTH_SETTING_KEYS = [
  'clientId',
  'clientSecret',
  'scopes',
  'resource',
  'authority',
  'discoveryUrl',
  'protectedResourceMetadataUrl',
  'redirectUri',
  'audience',
  'trustedHosts',
  'resourceParameter',
  'callbackMode',
  'strict',
] as const;

/** What the OAuth service provides to the store. Injected: it owns a URI handler. */
export interface StoreOAuth {
  accessToken(config: ServerConfig, requestUrl?: string): Promise<string>;
  secureSecretProjects(): Set<string>;
}

export interface WorkspaceOverrideReport {
  keys: string[];
  fingerprint?: string;
  approved: boolean;
  /** Each overridden key with a display-safe rendering of its workspace value. */
  values: Array<{ key: string; value: string }>;
}

/**
 * Persistence for server definitions. Three sources are merged: MCP projects
 * (`mcplab.projects`, plus the default project from `mcplab.serverUrl` /
 * `mcplab.oauth.*` or the MCP_* environment variables), servers the user added
 * through the UI (global state), and servers declared in `mcplab.servers`.
 * Credentials live in SecretStorage and never touch any of them.
 */
export class ServerStore {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly authProviders = new Map<string, AuthProvider>();
  private oauth?: StoreOAuth;

  constructor(private readonly context: vscode.ExtensionContext) {}

  useOAuth(service: StoreOAuth): void {
    this.oauth = service;
  }

  /** Projects first, then UI-added servers, then settings-declared ones; first id wins. */
  list(): ServerConfig[] {
    const projects = this.projectResolution().projects.map(projectToServerConfig);
    const ids = new Set(projects.map((s) => s.id));
    const user = this.listUserServers().filter((s) => !ids.has(s.id));
    user.forEach((s) => ids.add(s.id));
    const fromSettings = this.listSettingsServers().filter((s) => !ids.has(s.id));
    return [...projects, ...user, ...fromSettings].sort((a, b) => a.name.localeCompare(b.name));
  }

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------

  /** Every configured project, resolved, with the issues that block each one. */
  projectResolution(): ProjectResolution {
    const settings = vscode.workspace.getConfiguration('mcplab');
    const oauth: OAuthInput = {};
    for (const key of OAUTH_SETTING_KEYS) {
      oauth[key] = settings.get<unknown>(`oauth.${key}`);
    }
    const overrides = this.workspaceOverrides();
    return resolveProjects({
      projects: settings.get<unknown>('projects'),
      settings: { serverUrl: settings.get<unknown>('serverUrl'), oauth },
      env: process.env,
      secureClientSecrets: this.oauth?.secureSecretProjects(),
      workspaceOverrides: { keys: overrides.keys, approved: overrides.approved },
    });
  }

  /**
   * Security-sensitive settings the workspace overrides. A workspace may define
   * where credentials go - teams share project definitions - but only after the
   * user has seen what it sets and agreed. Approval is pinned to the values:
   * change them and it is asked again.
   */
  workspaceOverrides(): WorkspaceOverrideReport {
    const settings = vscode.workspace.getConfiguration('mcplab');
    const inspections = SENSITIVE_SETTING_KEYS.map((key) => {
      const inspected = settings.inspect<unknown>(key);
      return {
        key,
        workspaceValue: inspected?.workspaceValue,
        workspaceFolderValue: inspected?.workspaceFolderValue,
      };
    });
    const found = findWorkspaceOverrides(inspections);
    const approvals = this.context.globalState.get<string[]>(APPROVALS_KEY, []);
    return {
      keys: found.keys,
      fingerprint: found.fingerprint,
      approved: !!found.fingerprint && approvals.includes(found.fingerprint),
      values: inspections
        .filter((inspection) => found.keys.includes(inspection.key))
        .map((inspection) => ({
          key: `mcplab.${inspection.key}`,
          value: describeOverride(inspection.workspaceFolderValue ?? inspection.workspaceValue),
        })),
    };
  }

  async approveWorkspaceOverrides(fingerprint: string): Promise<void> {
    const approvals = new Set(this.context.globalState.get<string[]>(APPROVALS_KEY, []));
    approvals.add(fingerprint);
    await this.context.globalState.update(APPROVALS_KEY, [...approvals]);
    this.changed.fire();
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
      .getConfiguration('mcplab')
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
      throw new Error(
        config.source === 'project'
          ? 'MCP projects are edited in settings ("mcplab.projects") or through MCP_* environment variables.'
          : 'Only servers added in MCP Lab can be edited here.',
      );
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
        'This server is declared in settings. Remove it from "mcplab.servers" instead.',
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
   * Headers for one request to `requestUrl`. Providers are cached per server so
   * a client-credentials token is minted once and reused until close to expiry.
   */
  async authHeaders(config: ServerConfig, requestUrl?: string): Promise<Record<string, string>> {
    const auth: AuthConfig = config.auth ?? { kind: 'bearer' };

    // An interactive grant goes through the OAuth service, which refreshes it,
    // pins it to its project's origin, and raises a typed sign-in requirement
    // that the Connect command turns into a browser sign-in. Its errors pass
    // through unwrapped so that type survives.
    if (auth.kind === 'oauth') {
      if (!this.oauth) {
        throw new Error('OAuth is not available yet; try again once MCP Lab has finished activating.');
      }
      const token = await this.oauth.accessToken(config, requestUrl);
      return { ...(auth.headers ?? {}), authorization: `Bearer ${token}` };
    }

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

/** A workspace value as it is safe to show in an approval prompt. */
function describeOverride(value: unknown): string {
  if (typeof value === 'string') {
    return /^https?:\/\//i.test(value) ? sanitizeUrl(value) : value;
  }
  if (Array.isArray(value)) {
    if (value.every((entry) => entry && typeof entry === 'object')) {
      return value
        .map((entry) => {
          const project = entry as { id?: unknown; mcpUrl?: unknown; oauth?: { authority?: unknown } };
          const url = typeof project.mcpUrl === 'string' && /^https?:/i.test(project.mcpUrl) ? sanitizeUrl(project.mcpUrl) : String(project.mcpUrl ?? '?');
          const authority = typeof project.oauth?.authority === 'string' ? ` via ${sanitizeUrl(project.oauth.authority)}` : '';
          return `${String(project.id ?? '?')} → ${url}${authority}`;
        })
        .join('; ');
    }
    return value.map(String).join(', ');
  }
  return JSON.stringify(value);
}
