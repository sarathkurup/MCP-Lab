import type { ServerConfig } from './config';
import { classifyTool, type ToolRisk } from './environments';
import type { AnalyticsSummary } from './history';
import type { Prompt, Resource, Tool } from './protocol';

/**
 * The enterprise view: every MCP server a team can reach, what it exposes, who
 * owns it, and whether it is healthy - plus a search that spans all of them,
 * because "which server can check a deployment?" is the question people
 * actually have.
 */

export interface ServerMetadata {
  owner?: string;
  team?: string;
  repository?: string;
  documentation?: string;
  tags?: string[];
}

export type HealthState = 'healthy' | 'degraded' | 'unreachable' | 'unknown';

export interface CatalogEntry {
  id: string;
  name: string;
  metadata: ServerMetadata;
  version?: string;
  protocolVersion?: string;
  transport: string;
  target: string;
  environmentId?: string;
  health: HealthState;
  healthDetail?: string;
  counts: { tools: number; resources: number; prompts: number };
  risk: { read: number; write: number; destructive: number };
  usage?: { calls: number; failureRate: number; averageMs: number };
}

export interface CatalogInput {
  config: ServerConfig;
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  lastError?: string;
  serverVersion?: string;
  protocolVersion?: string;
  target: string;
  tools: Tool[];
  resources: Resource[];
  prompts: Prompt[];
  stats?: AnalyticsSummary;
}

export function buildCatalogEntry(input: CatalogInput): CatalogEntry {
  const risk = { read: 0, write: 0, destructive: 0 };
  for (const tool of input.tools) {
    risk[classifyTool(tool)]++;
  }

  return {
    id: input.config.id,
    name: input.config.name,
    metadata: input.config.metadata ?? {},
    version: input.serverVersion,
    protocolVersion: input.protocolVersion,
    transport: input.config.transport,
    target: input.target,
    environmentId: input.config.environmentId,
    health: health(input),
    healthDetail: healthDetail(input),
    counts: {
      tools: input.tools.length,
      resources: input.resources.length,
      prompts: input.prompts.length,
    },
    risk,
    usage: input.stats
      ? {
          calls: input.stats.total,
          failureRate: input.stats.total ? input.stats.failed / input.stats.total : 0,
          averageMs: input.stats.averageMs,
        }
      : undefined,
  };
}

function health(input: CatalogInput): HealthState {
  if (input.status === 'error') {
    return 'unreachable';
  }
  if (input.status !== 'connected') {
    return 'unknown';
  }
  const stats = input.stats;
  // A connected server that is failing most calls is not "healthy".
  if (stats && stats.total >= 5 && stats.failed / stats.total > 0.1) {
    return 'degraded';
  }
  if (stats && stats.p95Ms > 3000) {
    return 'degraded';
  }
  return 'healthy';
}

function healthDetail(input: CatalogInput): string | undefined {
  if (input.status === 'error') {
    return input.lastError;
  }
  if (input.status !== 'connected') {
    return 'Not connected';
  }
  const stats = input.stats;
  if (stats && stats.total >= 5 && stats.failed / stats.total > 0.1) {
    return `${((stats.failed / stats.total) * 100).toFixed(1)}% of calls failed`;
  }
  if (stats && stats.p95Ms > 3000) {
    return `p95 latency ${stats.p95Ms}ms`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchHit {
  serverId: string;
  serverName: string;
  kind: 'tool' | 'resource' | 'prompt' | 'server';
  name: string;
  description?: string;
  risk?: ToolRisk;
  score: number;
  /** Which part of the entry matched, for highlighting. */
  matchedOn: 'name' | 'description' | 'tag' | 'owner';
}

export interface SearchSource {
  serverId: string;
  serverName: string;
  metadata?: ServerMetadata;
  tools: Tool[];
  resources: Resource[];
  prompts: Prompt[];
}

/**
 * Ranked search across every server. Scoring is deliberately simple and
 * explainable: an exact name match beats a prefix, which beats a substring,
 * which beats a description hit. Multi-word queries require every term.
 */
export function searchCatalog(sources: SearchSource[], query: string, limit = 50): SearchHit[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);

  if (terms.length === 0) {
    return [];
  }

  const hits: SearchHit[] = [];

  for (const source of sources) {
    for (const tool of source.tools) {
      const hit = score(terms, tool.name, tool.description);
      if (hit) {
        hits.push({
          serverId: source.serverId,
          serverName: source.serverName,
          kind: 'tool',
          name: tool.name,
          description: tool.description,
          risk: classifyTool(tool),
          ...hit,
        });
      }
    }

    for (const resource of source.resources) {
      const hit = score(terms, resource.name || resource.uri, resource.description);
      if (hit) {
        hits.push({
          serverId: source.serverId,
          serverName: source.serverName,
          kind: 'resource',
          name: resource.uri,
          description: resource.description,
          ...hit,
        });
      }
    }

    for (const prompt of source.prompts) {
      const hit = score(terms, prompt.name, prompt.description);
      if (hit) {
        hits.push({
          serverId: source.serverId,
          serverName: source.serverName,
          kind: 'prompt',
          name: prompt.name,
          description: prompt.description,
          ...hit,
        });
      }
    }

    const serverHit = score(
      terms,
      source.serverName,
      [source.metadata?.team, source.metadata?.owner, ...(source.metadata?.tags ?? [])]
        .filter(Boolean)
        .join(' '),
    );
    if (serverHit) {
      hits.push({
        serverId: source.serverId,
        serverName: source.serverName,
        kind: 'server',
        name: source.serverName,
        description: source.metadata?.team,
        ...serverHit,
      });
    }
  }

  return hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
}

function score(
  terms: string[],
  name: string,
  description?: string,
): { score: number; matchedOn: SearchHit['matchedOn'] } | undefined {
  const haystackName = name.toLowerCase();
  const haystackDescription = (description ?? '').toLowerCase();

  // Every term must appear somewhere, so "deployment status" does not match a
  // tool that only mentions "deployment".
  const allPresent = terms.every(
    (term) => haystackName.includes(term) || haystackDescription.includes(term),
  );
  if (!allPresent) {
    return undefined;
  }

  const joined = terms.join(' ');
  const normalized = haystackName.replace(/[_-]/g, ' ');

  if (haystackName === joined || normalized === joined) {
    return { score: 100, matchedOn: 'name' };
  }
  if (normalized.startsWith(joined) || haystackName.startsWith(terms[0])) {
    return { score: 80, matchedOn: 'name' };
  }
  if (terms.every((term) => haystackName.includes(term))) {
    return { score: 60, matchedOn: 'name' };
  }
  if (terms.some((term) => haystackName.includes(term))) {
    return { score: 40, matchedOn: 'name' };
  }
  return { score: 20, matchedOn: 'description' };
}

/** What moved between two catalog snapshots, compared by stable item key. */
export interface CatalogDiff {
  added: string[];
  removed: string[];
}

/**
 * Compares the keys of two catalog snapshots.
 *
 * A server that announces `notifications/tools/list_changed` gets its catalog
 * refetched, and this is what turns the new list into "three tools appeared".
 * The first sighting deliberately reports nothing: without that, every server
 * would light up as entirely new the moment it was first drawn, which would
 * train people to ignore the signal.
 */
export function diffCatalogKeys(previous: string[] | undefined, current: string[]): CatalogDiff {
  if (!previous) {
    return { added: [], removed: [] };
  }
  const before = new Set(previous);
  const after = new Set(current);
  return {
    added: current.filter((key) => !before.has(key)),
    removed: previous.filter((key) => !after.has(key)),
  };
}

/** Groups hits by server, for rendering the results by origin. */
export function groupHits(hits: SearchHit[]): Map<string, SearchHit[]> {
  const grouped = new Map<string, SearchHit[]>();
  for (const hit of hits) {
    const list = grouped.get(hit.serverName) ?? [];
    list.push(hit);
    grouped.set(hit.serverName, list);
  }
  return grouped;
}
