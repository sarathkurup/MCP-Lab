import type { AuthConfig } from './auth';
import type { EnvironmentOverride } from './environments';

export type TransportKind = 'stdio' | 'http';

/** Where a server definition came from, which decides whether it can be edited. */
export type ConfigSource = 'user' | 'settings';

export interface ServerConfig {
  id: string;
  name: string;
  transport: TransportKind;

  // stdio
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;

  // http
  url?: string;
  headers?: Record<string, string>;

  /** How to authenticate. The secret itself never lives in this object. */
  auth?: AuthConfig;

  autoConnect?: boolean;
  source?: ConfigSource;

  /** Per-environment overrides, keyed by environment id. */
  environments?: Record<string, EnvironmentOverride>;
  /** The environment this resolved config was built for, set by resolveForEnvironment. */
  environmentId?: string;
}

export interface ValidationIssue {
  field: string;
  message: string;
}

/** Structural validation only - it never dials the server. */
export function validateServerConfig(config: Partial<ServerConfig>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!config.name || !config.name.trim()) {
    issues.push({ field: 'name', message: 'Name is required' });
  }

  if (config.transport !== 'stdio' && config.transport !== 'http') {
    issues.push({ field: 'transport', message: 'Transport must be "stdio" or "http"' });
    return issues;
  }

  if (config.transport === 'stdio') {
    if (!config.command || !config.command.trim()) {
      issues.push({ field: 'command', message: 'Command is required for a stdio server' });
    }
    if (config.args && !Array.isArray(config.args)) {
      issues.push({ field: 'args', message: 'Args must be an array of strings' });
    }
  }

  if (config.transport === 'http') {
    if (!config.url || !config.url.trim()) {
      issues.push({ field: 'url', message: 'URL is required for an HTTP server' });
    } else {
      let parsed: URL | undefined;
      try {
        parsed = new URL(config.url);
      } catch {
        issues.push({ field: 'url', message: `"${config.url}" is not a valid URL` });
      }
      if (parsed && parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        issues.push({ field: 'url', message: 'URL must use http or https' });
      }
    }
  }

  return issues;
}

/** A stable, readable id derived from the name, unique within `taken`. */
export function deriveServerId(name: string, taken: Iterable<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'server';

  const existing = new Set(taken);
  if (!existing.has(base)) {
    return base;
  }
  let n = 2;
  while (existing.has(`${base}-${n}`)) {
    n++;
  }
  return `${base}-${n}`;
}

/** One-line summary of where a server lives, for tree descriptions and logs. */
export function describeTarget(config: ServerConfig): string {
  if (config.transport === 'stdio') {
    return [config.command, ...(config.args ?? [])].filter(Boolean).join(' ');
  }
  return config.url ?? '';
}
