import type { AuthConfig } from './auth';
import type { ServerConfig } from './config';
import type { Tool } from './protocol';

export type EnvironmentTier = 'dev' | 'qc' | 'prod';

export interface Environment {
  id: string;
  name: string;
  tier: EnvironmentTier;
  color: string;
  /** Substituted into a server's env block when this environment is active. */
  variables?: Record<string, string>;
}

/** Per-environment overrides carried on a server definition. */
export interface EnvironmentOverride {
  url?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  auth?: AuthConfig;
}

export const DEFAULT_ENVIRONMENTS: Environment[] = [
  { id: 'dev', name: 'DEV', tier: 'dev', color: '#3fb950' },
  { id: 'qc', name: 'QC', tier: 'qc', color: '#d29922' },
  { id: 'prod', name: 'PROD', tier: 'prod', color: '#f85149' },
];

/**
 * Applies the active environment's override to a server definition. The base
 * config is never mutated, so switching environments is reversible.
 */
export function resolveForEnvironment(
  config: ServerConfig,
  environmentId?: string,
): ServerConfig {
  if (!environmentId) {
    return config;
  }
  const override = config.environments?.[environmentId];
  if (!override) {
    return config;
  }
  return {
    ...config,
    url: override.url ?? config.url,
    command: override.command ?? config.command,
    args: override.args ?? config.args,
    cwd: override.cwd ?? config.cwd,
    env: { ...(config.env ?? {}), ...(override.env ?? {}) },
    headers: { ...(config.headers ?? {}), ...(override.headers ?? {}) },
    auth: override.auth ?? config.auth,
    environmentId,
  };
}

export type ToolRisk = 'read' | 'write' | 'destructive';

/**
 * Risk classification used by the production guard. Annotations win; the name
 * is only a fallback, because a server that annotates nothing still ships
 * tools called `deleteEverything`.
 */
export function classifyTool(tool: Tool): ToolRisk {
  const annotations = tool.annotations ?? {};
  if (annotations.destructiveHint === true) {
    return 'destructive';
  }
  if (annotations.readOnlyHint === true) {
    return 'read';
  }
  if (/(delete|destroy|drop|purge|remove|truncate|wipe|revoke|terminate)/i.test(tool.name)) {
    return 'destructive';
  }
  if (/^(get|list|read|search|find|query|fetch|describe|show|check|status)/i.test(tool.name)) {
    return 'read';
  }
  return 'write';
}

export interface GuardDecision {
  /** Whether the user must confirm before the call is made. */
  confirm: boolean;
  reason?: string;
  severity: 'none' | 'warning' | 'danger';
}

/**
 * One gate for every invocation. Production is strict; lower tiers only stop
 * for genuinely destructive operations.
 */
export function guard(risk: ToolRisk, tier: EnvironmentTier | undefined): GuardDecision {
  if (tier === 'prod') {
    if (risk === 'read') {
      return { confirm: false, severity: 'none' };
    }
    return {
      confirm: true,
      severity: risk === 'destructive' ? 'danger' : 'warning',
      reason:
        risk === 'destructive'
          ? 'This is a destructive operation against PRODUCTION.'
          : 'This writes to PRODUCTION.',
    };
  }

  if (risk === 'destructive') {
    return {
      confirm: true,
      severity: 'warning',
      reason: 'This operation may change or delete data.',
    };
  }

  return { confirm: false, severity: 'none' };
}
