/**
 * MCP projects: an MCP endpoint plus the OAuth configuration needed to reach it.
 *
 * Projects come from two places. `mcplab.projects` lists named projects, each
 * self-contained - nothing is inherited between them, because two projects can
 * use entirely different identity providers, clients, scopes and resources.
 * Separately, a single *default* project can be described by `mcplab.serverUrl`
 * plus `mcplab.oauth.*`, or by the MCP_URL / MCP_OAUTH_* environment variables.
 *
 * Resolution order, per value:
 *   1. the project's own configuration (named projects only)
 *   2. extension configuration - settings, and secure storage for a secret
 *   3. environment variables (default project only)
 *   4. discovery, at sign-in time
 *   5. safe defaults for non-sensitive values
 *
 * A resolved project never holds a client secret. It records where the secret
 * lives - an environment variable name or secure storage - and the session
 * manager reads it at the moment of the token request, so the value is never in
 * a config object that could reach a log, a webview or a settings file.
 */

import { createHash } from 'node:crypto';
import type { ServerConfig } from './config';
import { isLoopbackHost, isSecureUrl, normalizeUrl, parseScopes, tryParseUrl } from './oauth';

export type CallbackMode = 'auto' | 'uri' | 'loopback';
export type ResourceParameterPolicy = 'auto' | 'always' | 'never';
export type ConfigLayer = 'project' | 'settings' | 'secure-storage' | 'environment' | 'default';
export type ProjectOrigin = 'projects' | 'default' | 'adhoc';

export type ClientSecretSource =
  | { kind: 'environment'; variable: string }
  | { kind: 'secure-storage' };

export interface ResolvedOAuthSettings {
  clientId?: string;
  /** Where a confidential client's secret lives. Never the secret. */
  clientSecretSource?: ClientSecretSource;
  scopes: string[];
  /** The protected resource; the MCP URL unless configured otherwise. */
  resource: string;
  /** True when `resource` was configured rather than defaulted. */
  resourceConfigured: boolean;
  authority?: string;
  discoveryUrl?: string;
  protectedResourceMetadataUrl?: string;
  redirectUri?: string;
  /** Expected access-token audience; when set it is enforced. */
  audience?: string;
  /** Extra hosts discovery may lead to without asking. */
  trustedHosts: string[];
  resourceParameter: ResourceParameterPolicy;
  callbackMode: CallbackMode;
  /** Refuse anything that cannot be verified instead of warning about it. */
  strict: boolean;
}

export interface ProjectIssue {
  projectId: string;
  /** The project field, e.g. `mcpUrl` or `oauth.clientId`. */
  key: string;
  /** What to set to fix it: an environment variable or a setting name. Never a value. */
  configKeys?: string[];
  severity: 'error' | 'warning';
  message: string;
}

export interface ResolvedProject {
  id: string;
  displayName: string;
  mcpUrl: string;
  oauth: ResolvedOAuthSettings;
  origin: ProjectOrigin;
  /** Which layer each value came from, for diagnostics. */
  sources: Record<string, ConfigLayer>;
  /** Environment variables a value was read through, by field. */
  environmentReferences: Record<string, string>;
  issues: ProjectIssue[];
  /** Security-sensitive values that come from workspace settings and await approval. */
  pendingApproval?: string[];
}

/** The environment variables that describe the default project. */
export const ENV_KEYS = {
  mcpUrl: 'MCP_URL',
  clientId: 'MCP_OAUTH_CLIENT_ID',
  clientSecret: 'MCP_OAUTH_CLIENT_SECRET',
  scopes: 'MCP_OAUTH_SCOPES',
  resource: 'MCP_OAUTH_RESOURCE',
  authority: 'MCP_OAUTH_AUTHORITY',
  discoveryUrl: 'MCP_OAUTH_DISCOVERY_URL',
  protectedResourceMetadataUrl: 'MCP_OAUTH_PROTECTED_RESOURCE_METADATA_URL',
  redirectUri: 'MCP_OAUTH_REDIRECT_URI',
} as const;

/** The settings that describe the default project. */
export const SETTING_KEYS = {
  mcpUrl: 'mcplab.serverUrl',
  clientId: 'mcplab.oauth.clientId',
  scopes: 'mcplab.oauth.scopes',
  resource: 'mcplab.oauth.resource',
  authority: 'mcplab.oauth.authority',
  discoveryUrl: 'mcplab.oauth.discoveryUrl',
  protectedResourceMetadataUrl: 'mcplab.oauth.protectedResourceMetadataUrl',
  redirectUri: 'mcplab.oauth.redirectUri',
} as const;

/**
 * Settings that decide where credentials go. A workspace may set them - teams
 * share project definitions - but never silently: the user approves first.
 */
export const SENSITIVE_SETTING_KEYS = [
  'projects',
  'serverUrl',
  'oauth.clientId',
  'oauth.resource',
  'oauth.authority',
  'oauth.discoveryUrl',
  'oauth.protectedResourceMetadataUrl',
  'oauth.redirectUri',
  'oauth.trustedHosts',
  'oauth.audience',
] as const;

export const DEFAULT_PROJECT_ID = 'default';

/** Raw OAuth fields as written in settings; everything is unknown until checked. */
export interface OAuthInput {
  clientId?: unknown;
  clientSecret?: unknown;
  scopes?: unknown;
  resource?: unknown;
  authority?: unknown;
  discoveryUrl?: unknown;
  protectedResourceMetadataUrl?: unknown;
  redirectUri?: unknown;
  audience?: unknown;
  trustedHosts?: unknown;
  resourceParameter?: unknown;
  callbackMode?: unknown;
  strict?: unknown;
}

export interface ProjectResolutionInput {
  /** `mcplab.projects`, as VS Code resolved it. */
  projects?: unknown;
  /** `mcplab.serverUrl` and `mcplab.oauth.*`, for the default project. */
  settings?: { serverUrl?: unknown; oauth?: OAuthInput };
  env: Record<string, string | undefined>;
  /** Project ids with a client secret in secure storage. */
  secureClientSecrets?: ReadonlySet<string>;
  /** Sensitive keys set by the workspace, and whether the user approved them. */
  workspaceOverrides?: { keys: string[]; approved: boolean };
}

export interface ProjectResolution {
  projects: ResolvedProject[];
  issues: ProjectIssue[];
}

// ---------------------------------------------------------------------------
// ${env:NAME}
// ---------------------------------------------------------------------------

const ENV_REFERENCE = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

interface Substituted {
  value?: string;
  /** Variables referenced. */
  variables: string[];
  /** Variables referenced but not set. */
  missing: string[];
}

/** Expands `${env:NAME}` references. An unset variable leaves the value missing. */
export function substituteEnv(raw: unknown, env: Record<string, string | undefined>): Substituted {
  if (typeof raw !== 'string') return { variables: [], missing: [] };
  const variables: string[] = [];
  const missing: string[] = [];
  const value = raw.replace(ENV_REFERENCE, (_match, name: string) => {
    variables.push(name);
    const resolved = env[name];
    if (resolved === undefined || resolved === '') missing.push(name);
    return resolved ?? '';
  });
  const trimmed = value.trim();
  return { value: missing.length || !trimmed ? undefined : trimmed, variables, missing };
}

/** True when the string is exactly one `${env:NAME}` reference and nothing else. */
function pureEnvReference(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const match = /^\s*\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}\s*$/.exec(raw);
  return match?.[1];
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

class Builder {
  readonly sources: Record<string, ConfigLayer> = {};
  readonly environmentReferences: Record<string, string> = {};
  readonly issues: ProjectIssue[] = [];

  constructor(readonly projectId: string) {}

  issue(key: string, severity: 'error' | 'warning', message: string, configKeys?: string[]): void {
    this.issues.push({ projectId: this.projectId, key, severity, message, configKeys });
  }
}

/** Reads one string field from the first layer that has it. */
function pick(
  builder: Builder,
  key: string,
  layers: Array<{ layer: ConfigLayer; raw: unknown; label: string }>,
  env: Record<string, string | undefined>,
): string | undefined {
  for (const { layer, raw, label } of layers) {
    if (raw === undefined || raw === null || raw === '') continue;
    if (typeof raw !== 'string') {
      builder.issue(key, 'error', `${label} must be a string`);
      continue;
    }
    const resolved = substituteEnv(raw, env);
    if (resolved.variables.length) builder.environmentReferences[key] = resolved.variables.join(', ');
    if (resolved.missing.length) {
      builder.issue(
        key,
        'error',
        `${label} references ${resolved.missing.map((name) => `\${env:${name}}`).join(', ')}, which is not set`,
        resolved.missing,
      );
      return undefined;
    }
    if (resolved.value !== undefined) {
      builder.sources[key] = layer;
      return resolved.value;
    }
  }
  return undefined;
}

function pickScopes(
  builder: Builder,
  layers: Array<{ layer: ConfigLayer; raw: unknown; label: string }>,
  env: Record<string, string | undefined>,
): string[] {
  for (const { layer, raw, label } of layers) {
    if (raw === undefined || raw === null || raw === '') continue;
    const parts: unknown[] = Array.isArray(raw) ? raw : [raw];
    const scopes: string[] = [];
    let failed = false;
    for (const part of parts) {
      if (typeof part !== 'string') {
        builder.issue('oauth.scopes', 'error', `${label} must be a string or a list of strings`);
        failed = true;
        break;
      }
      const resolved = substituteEnv(part, env);
      if (resolved.variables.length) {
        builder.environmentReferences['oauth.scopes'] = resolved.variables.join(', ');
      }
      if (resolved.missing.length) {
        builder.issue(
          'oauth.scopes',
          'error',
          `${label} references ${resolved.missing.map((name) => `\${env:${name}}`).join(', ')}, which is not set`,
          resolved.missing,
        );
        failed = true;
        break;
      }
      scopes.push(...parseScopes(resolved.value));
    }
    if (failed) return [];
    if (scopes.length) {
      builder.sources['oauth.scopes'] = layer;
      return [...new Set(scopes)];
    }
  }
  return [];
}

function readEnum<T extends string>(
  builder: Builder,
  key: string,
  raw: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  if (raw === undefined || raw === null || raw === '') {
    builder.sources[key] = 'default';
    return fallback;
  }
  if (typeof raw === 'string' && (allowed as readonly string[]).includes(raw)) {
    builder.sources[key] = 'settings';
    return raw as T;
  }
  builder.issue(key, 'warning', `${key} must be one of ${allowed.join(', ')}; using "${fallback}"`);
  builder.sources[key] = 'default';
  return fallback;
}

function readHosts(builder: Builder, raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    builder.issue('oauth.trustedHosts', 'error', 'oauth.trustedHosts must be a list of host names');
    return [];
  }
  const hosts: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !/^[a-z0-9.-]+(:\d+)?$/i.test(entry.trim())) {
      builder.issue(
        'oauth.trustedHosts',
        'error',
        `oauth.trustedHosts entries must be bare host names such as "login.example.com", not URLs`,
      );
      continue;
    }
    hosts.push(entry.trim().toLowerCase());
  }
  return hosts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validation that applies however a project was described. Messages name the
 * field and what to set; they never include a value that could be secret.
 */
function validate(builder: Builder, project: ResolvedProject, labels: Record<string, string[]>): void {
  const needsClient = project.origin !== 'adhoc';

  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(project.id)) {
    builder.issue('id', 'error', 'Project id must be letters, digits, ".", "_" or "-" (at most 64)');
  }

  if (!project.mcpUrl) {
    if (!builder.issues.some((issue) => issue.key === 'mcpUrl')) {
      builder.issue('mcpUrl', 'error', 'The MCP server URL is missing', labels.mcpUrl);
    }
  } else {
    const url = tryParseUrl(project.mcpUrl);
    if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
      builder.issue('mcpUrl', 'error', 'The MCP server URL is not a valid http(s) URL', labels.mcpUrl);
    } else if (!isSecureUrl(url)) {
      builder.issue(
        'mcpUrl',
        'error',
        'The MCP server URL must use HTTPS; plain HTTP is only allowed to localhost',
        labels.mcpUrl,
      );
    } else if (url.pathname.includes('/.well-known/')) {
      builder.issue(
        'mcpUrl',
        'error',
        'The MCP server URL points at a .well-known metadata document; use the MCP transport endpoint instead',
        labels.mcpUrl,
      );
    }
  }

  if (needsClient && !project.oauth.clientId && !builder.issues.some((issue) => issue.key === 'oauth.clientId')) {
    builder.issue('oauth.clientId', 'error', 'The OAuth client id is missing', labels.clientId);
  }
  if (needsClient && project.oauth.scopes.length === 0 && !builder.issues.some((issue) => issue.key === 'oauth.scopes')) {
    builder.issue('oauth.scopes', 'error', 'No OAuth scopes are configured', labels.scopes);
  }

  if (project.oauth.resourceConfigured) {
    const url = tryParseUrl(project.oauth.resource);
    if (!url) {
      builder.issue('oauth.resource', 'error', 'The OAuth resource must be an absolute URI', labels.resource);
    } else if (url.hash) {
      builder.issue('oauth.resource', 'error', 'The OAuth resource must not contain a fragment (RFC 8707)', labels.resource);
    }
  }

  for (const [key, value, label] of [
    ['oauth.authority', project.oauth.authority, labels.authority],
    ['oauth.discoveryUrl', project.oauth.discoveryUrl, labels.discoveryUrl],
    ['oauth.protectedResourceMetadataUrl', project.oauth.protectedResourceMetadataUrl, labels.protectedResourceMetadataUrl],
  ] as const) {
    if (!value) continue;
    if (!isSecureUrl(value)) {
      builder.issue(key, 'error', `${key} must be an HTTPS URL`, label);
    } else if (project.mcpUrl && normalizeUrl(value) === normalizeUrl(project.mcpUrl)) {
      builder.issue(key, 'error', `${key} must not be the MCP server URL itself`, label);
    }
  }

  if (project.oauth.redirectUri) {
    const url = tryParseUrl(project.oauth.redirectUri);
    if (!url) {
      builder.issue('oauth.redirectUri', 'error', 'The redirect URI is not a valid URI', labels.redirectUri);
    } else if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
      builder.issue(
        'oauth.redirectUri',
        'error',
        'An http redirect URI must point at 127.0.0.1, localhost or [::1]',
        labels.redirectUri,
      );
    } else if (['javascript:', 'data:', 'file:'].includes(url.protocol)) {
      builder.issue('oauth.redirectUri', 'error', `A ${url.protocol} redirect URI is not allowed`, labels.redirectUri);
    }
  }
}

function buildProject(
  id: string,
  displayName: string,
  origin: ProjectOrigin,
  builder: Builder,
  fields: {
    mcpUrl?: string;
    clientId?: string;
    clientSecretSource?: ClientSecretSource;
    scopes: string[];
    resource?: string;
    authority?: string;
    discoveryUrl?: string;
    protectedResourceMetadataUrl?: string;
    redirectUri?: string;
    audience?: string;
    trustedHosts: string[];
    resourceParameter: ResourceParameterPolicy;
    callbackMode: CallbackMode;
    strict: boolean;
  },
  labels: Record<string, string[]>,
): ResolvedProject {
  const mcpUrl = fields.mcpUrl ?? '';
  if (!fields.resource) builder.sources['oauth.resource'] = 'default';
  const project: ResolvedProject = {
    id,
    displayName,
    mcpUrl,
    origin,
    oauth: {
      clientId: fields.clientId,
      clientSecretSource: fields.clientSecretSource,
      scopes: fields.scopes,
      resource: fields.resource ?? mcpUrl,
      resourceConfigured: fields.resource !== undefined,
      authority: fields.authority,
      discoveryUrl: fields.discoveryUrl,
      protectedResourceMetadataUrl: fields.protectedResourceMetadataUrl,
      redirectUri: fields.redirectUri,
      audience: fields.audience,
      trustedHosts: fields.trustedHosts,
      resourceParameter: fields.resourceParameter,
      callbackMode: fields.callbackMode,
      strict: fields.strict,
    },
    sources: builder.sources,
    environmentReferences: builder.environmentReferences,
    issues: builder.issues,
  };
  validate(builder, project, labels);
  return project;
}

/** A client secret may only be named by reference, never written into settings. */
function resolveSecretReference(
  builder: Builder,
  raw: unknown,
  label: string,
  env: Record<string, string | undefined>,
): ClientSecretSource | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const variable = pureEnvReference(raw);
  if (!variable) {
    builder.issue(
      'oauth.clientSecret',
      'error',
      `${label} must be an environment reference such as "\${env:MY_CLIENT_SECRET}". ` +
        'A client secret written into settings is ignored, because settings files are shared and synced.',
    );
    return undefined;
  }
  if (!env[variable]) {
    builder.issue(
      'oauth.clientSecret',
      'error',
      `${label} references \${env:${variable}}, which is not set`,
      [variable],
    );
    return undefined;
  }
  builder.sources['oauth.clientSecret'] = 'environment';
  builder.environmentReferences['oauth.clientSecret'] = variable;
  return { kind: 'environment', variable };
}

function resolveNamedProject(
  entry: unknown,
  index: number,
  input: ProjectResolutionInput,
): ResolvedProject | ProjectIssue {
  if (!isRecord(entry)) {
    return {
      projectId: `#${index + 1}`,
      key: 'projects',
      severity: 'error',
      message: `mcplab.projects[${index}] is not an object`,
    };
  }
  const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : '';
  if (!id) {
    return {
      projectId: `#${index + 1}`,
      key: 'id',
      severity: 'error',
      message: `mcplab.projects[${index}] has no "id"`,
    };
  }

  const builder = new Builder(id);
  const env = input.env;
  const oauth: OAuthInput = isRecord(entry.oauth) ? entry.oauth : {};
  const label = (field: string) => `Project "${id}": ${field}`;
  const one = (field: string, raw: unknown) => [{ layer: 'project' as const, raw, label: label(field) }];

  const clientSecretSource =
    resolveSecretReference(builder, oauth.clientSecret, label('oauth.clientSecret'), env) ??
    (input.secureClientSecrets?.has(id) ? { kind: 'secure-storage' as const } : undefined);
  if (clientSecretSource?.kind === 'secure-storage') builder.sources['oauth.clientSecret'] = 'secure-storage';

  const displayName =
    typeof entry.displayName === 'string' && entry.displayName.trim() ? entry.displayName.trim() : id;
  const projectLabel = (field: string) => [`mcplab.projects[${index}].${field}`];

  return buildProject(
    id,
    displayName,
    'projects',
    builder,
    {
      mcpUrl: pick(builder, 'mcpUrl', one('mcpUrl', entry.mcpUrl), env),
      clientId: pick(builder, 'oauth.clientId', one('oauth.clientId', oauth.clientId), env),
      clientSecretSource,
      scopes: pickScopes(builder, one('oauth.scopes', oauth.scopes), env),
      resource: pick(builder, 'oauth.resource', one('oauth.resource', oauth.resource), env),
      authority: pick(builder, 'oauth.authority', one('oauth.authority', oauth.authority), env),
      discoveryUrl: pick(builder, 'oauth.discoveryUrl', one('oauth.discoveryUrl', oauth.discoveryUrl), env),
      protectedResourceMetadataUrl: pick(
        builder,
        'oauth.protectedResourceMetadataUrl',
        one('oauth.protectedResourceMetadataUrl', oauth.protectedResourceMetadataUrl),
        env,
      ),
      redirectUri: pick(builder, 'oauth.redirectUri', one('oauth.redirectUri', oauth.redirectUri), env),
      audience: pick(builder, 'oauth.audience', one('oauth.audience', oauth.audience), env),
      trustedHosts: readHosts(builder, oauth.trustedHosts),
      resourceParameter: readEnum(builder, 'oauth.resourceParameter', oauth.resourceParameter, ['auto', 'always', 'never'], 'auto'),
      callbackMode: readEnum(builder, 'oauth.callbackMode', oauth.callbackMode, ['auto', 'uri', 'loopback'], 'auto'),
      strict: oauth.strict === true,
    },
    {
      mcpUrl: projectLabel('mcpUrl'),
      clientId: projectLabel('oauth.clientId'),
      scopes: projectLabel('oauth.scopes'),
      resource: projectLabel('oauth.resource'),
      authority: projectLabel('oauth.authority'),
      discoveryUrl: projectLabel('oauth.discoveryUrl'),
      protectedResourceMetadataUrl: projectLabel('oauth.protectedResourceMetadataUrl'),
      redirectUri: projectLabel('oauth.redirectUri'),
    },
  );
}

/** True when anything at all describes a default project. */
function defaultProjectRequested(input: ProjectResolutionInput): boolean {
  const settings = input.settings ?? {};
  const oauth = settings.oauth ?? {};
  // Only values that identify an endpoint or a client make a project; the
  // behavioural switches have defaults and say nothing on their own.
  const identifying = [
    settings.serverUrl,
    oauth.clientId,
    oauth.authority,
    oauth.resource,
    oauth.discoveryUrl,
    oauth.protectedResourceMetadataUrl,
  ];
  if (identifying.some((value) => typeof value === 'string' && value.trim() !== '')) return true;
  return Object.values(ENV_KEYS).some((key) => !!input.env[key]);
}

function resolveDefaultProject(input: ProjectResolutionInput): ResolvedProject {
  const builder = new Builder(DEFAULT_PROJECT_ID);
  const env = input.env;
  const settings = input.settings ?? {};
  const oauth: OAuthInput = settings.oauth ?? {};

  const layers = (field: keyof typeof SETTING_KEYS, settingRaw: unknown) => [
    { layer: 'settings' as const, raw: settingRaw, label: SETTING_KEYS[field] },
    { layer: 'environment' as const, raw: env[ENV_KEYS[field]], label: ENV_KEYS[field] },
  ];
  const labels = (field: keyof typeof SETTING_KEYS) => [ENV_KEYS[field], SETTING_KEYS[field]];

  // Secure storage outranks the environment, and a secret in settings is refused.
  let clientSecretSource: ClientSecretSource | undefined;
  if (oauth.clientSecret !== undefined && oauth.clientSecret !== '') {
    clientSecretSource = resolveSecretReference(builder, oauth.clientSecret, 'mcplab.oauth.clientSecret', env);
  }
  if (!clientSecretSource && input.secureClientSecrets?.has(DEFAULT_PROJECT_ID)) {
    clientSecretSource = { kind: 'secure-storage' };
    builder.sources['oauth.clientSecret'] = 'secure-storage';
  }
  if (!clientSecretSource && env[ENV_KEYS.clientSecret]) {
    clientSecretSource = { kind: 'environment', variable: ENV_KEYS.clientSecret };
    builder.sources['oauth.clientSecret'] = 'environment';
  }

  return buildProject(
    DEFAULT_PROJECT_ID,
    'Default project',
    'default',
    builder,
    {
      mcpUrl: pick(builder, 'mcpUrl', layers('mcpUrl', settings.serverUrl), env),
      clientId: pick(builder, 'oauth.clientId', layers('clientId', oauth.clientId), env),
      clientSecretSource,
      scopes: pickScopes(
        builder,
        [
          { layer: 'settings', raw: oauth.scopes, label: SETTING_KEYS.scopes },
          { layer: 'environment', raw: env[ENV_KEYS.scopes], label: ENV_KEYS.scopes },
        ],
        env,
      ),
      resource: pick(builder, 'oauth.resource', layers('resource', oauth.resource), env),
      authority: pick(builder, 'oauth.authority', layers('authority', oauth.authority), env),
      discoveryUrl: pick(builder, 'oauth.discoveryUrl', layers('discoveryUrl', oauth.discoveryUrl), env),
      protectedResourceMetadataUrl: pick(
        builder,
        'oauth.protectedResourceMetadataUrl',
        layers('protectedResourceMetadataUrl', oauth.protectedResourceMetadataUrl),
        env,
      ),
      redirectUri: pick(builder, 'oauth.redirectUri', layers('redirectUri', oauth.redirectUri), env),
      audience: pick(builder, 'oauth.audience', [{ layer: 'settings', raw: oauth.audience, label: 'mcplab.oauth.audience' }], env),
      trustedHosts: readHosts(builder, oauth.trustedHosts),
      resourceParameter: readEnum(builder, 'oauth.resourceParameter', oauth.resourceParameter, ['auto', 'always', 'never'], 'auto'),
      callbackMode: readEnum(builder, 'oauth.callbackMode', oauth.callbackMode, ['auto', 'uri', 'loopback'], 'auto'),
      strict: oauth.strict === true,
    },
    {
      mcpUrl: labels('mcpUrl'),
      clientId: labels('clientId'),
      scopes: labels('scopes'),
      resource: labels('resource'),
      authority: labels('authority'),
      discoveryUrl: labels('discoveryUrl'),
      protectedResourceMetadataUrl: labels('protectedResourceMetadataUrl'),
      redirectUri: labels('redirectUri'),
    },
  );
}

/** Resolves every configured project, with the issues that stop each one connecting. */
export function resolveProjects(input: ProjectResolutionInput): ProjectResolution {
  const projects: ResolvedProject[] = [];
  const issues: ProjectIssue[] = [];
  const ids = new Set<string>();

  const raw = input.projects;
  if (raw !== undefined && raw !== null && !Array.isArray(raw)) {
    issues.push({ projectId: '*', key: 'projects', severity: 'error', message: 'mcplab.projects must be a list' });
  }
  const entries = Array.isArray(raw) ? raw : [];

  entries.forEach((entry, index) => {
    const resolved = resolveNamedProject(entry, index, input);
    if (!('oauth' in resolved)) {
      issues.push(resolved);
      return;
    }
    if (ids.has(resolved.id)) {
      issues.push({
        projectId: resolved.id,
        key: 'id',
        severity: 'error',
        message: `Project id "${resolved.id}" is used more than once; later definitions are ignored`,
      });
      return;
    }
    ids.add(resolved.id);
    projects.push(resolved);
  });

  if (defaultProjectRequested(input)) {
    if (ids.has(DEFAULT_PROJECT_ID)) {
      issues.push({
        projectId: DEFAULT_PROJECT_ID,
        key: 'id',
        severity: 'warning',
        message: 'A named project uses the id "default", so MCP_URL / mcplab.serverUrl are ignored',
      });
    } else {
      projects.push(resolveDefaultProject(input));
    }
  }

  const overrides = input.workspaceOverrides;
  if (overrides && overrides.keys.length && !overrides.approved) {
    for (const project of projects) {
      const keys = overrides.keys.filter((key) =>
        project.origin === 'projects' ? key === 'projects' : key !== 'projects',
      );
      if (keys.length) project.pendingApproval = keys.map((key) => `mcplab.${key}`);
    }
  }

  for (const project of projects) issues.push(...project.issues);
  return { projects, issues };
}

/** A project for a server added by hand: same flow, but the client may register itself. */
export function adhocProject(config: ServerConfig): ResolvedProject {
  const builder = new Builder(config.id);
  const scopes = parseScopes(config.auth?.scope);
  return buildProject(
    config.id,
    config.name,
    'adhoc',
    builder,
    {
      mcpUrl: config.url,
      clientId: config.auth?.clientId,
      scopes,
      trustedHosts: [],
      resourceParameter: 'auto',
      callbackMode: 'auto',
      strict: false,
    },
    { mcpUrl: ['server URL'] },
  );
}

/** Errors that block a project from being used at all. */
export function blockingIssues(project: ResolvedProject): ProjectIssue[] {
  return project.issues.filter((issue) => issue.severity === 'error');
}

/**
 * One sentence per missing or invalid setting, naming what to set and never
 * echoing a value.
 */
export function describeIssues(issues: ProjectIssue[]): string {
  return issues
    .map((issue) =>
      issue.configKeys?.length
        ? `${issue.message} (set ${issue.configKeys.join(' or ')})`
        : issue.message,
    )
    .join('; ');
}

/** The server definition a project becomes, so every existing view can show it. */
export function projectToServerConfig(project: ResolvedProject): ServerConfig {
  return {
    id: project.id,
    name: project.displayName,
    transport: 'http',
    url: project.mcpUrl,
    auth: {
      kind: 'oauth',
      clientId: project.oauth.clientId,
      scope: project.oauth.scopes.join(' '),
    },
    source: 'project',
    project,
  };
}

/**
 * What a stored session is bound to. A session survives only while the
 * project still points at the same endpoint, resource and client: change any
 * of them and the old tokens are not reused.
 */
export function bindingKey(project: ResolvedProject): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        normalizeUrl(project.mcpUrl),
        normalizeUrl(project.oauth.resource),
        project.oauth.clientId ?? '(dynamic)',
        project.oauth.authority ? normalizeUrl(project.oauth.authority) : '',
      ]),
    )
    .digest('hex')
    .slice(0, 16);
}

export interface SettingInspection {
  key: string;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
}

/**
 * The security-sensitive keys a workspace sets, and a fingerprint of what it
 * sets them to. Approval is recorded against the fingerprint, so a workspace
 * that later changes the value has to be approved again.
 */
export function findWorkspaceOverrides(inspections: SettingInspection[]): {
  keys: string[];
  fingerprint?: string;
} {
  const sensitive = new Set<string>(SENSITIVE_SETTING_KEYS);
  const overridden = inspections.filter(
    (inspection) =>
      sensitive.has(inspection.key) &&
      (inspection.workspaceValue !== undefined || inspection.workspaceFolderValue !== undefined),
  );
  if (overridden.length === 0) return { keys: [] };
  const payload = overridden.map((inspection) => [
    inspection.key,
    inspection.workspaceValue ?? null,
    inspection.workspaceFolderValue ?? null,
  ]);
  return {
    keys: overridden.map((inspection) => inspection.key),
    fingerprint: createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32),
  };
}
