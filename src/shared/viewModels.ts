import type { ConnectionStatus } from '../core/McpConnection';
import type { HistoryEntry } from '../core/history';
import type { LogEntry } from '../core/logging';
import type { Prompt, Resource, ResourceTemplate, ServerCapabilities, Tool } from '../core/protocol';
import type { TraceEntry } from '../core/trace';

/** Everything the webview needs about one server, flattened for transfer. */
export interface ServerSummary {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  target: string;
  status: ConnectionStatus;
  error?: string;
  source?: 'user' | 'settings';
  environmentId?: string;
  serverInfo?: { name: string; version: string; title?: string };
  protocolVersion?: string;
  capabilities?: ServerCapabilities;
  instructions?: string;
  counts: {
    tools: number;
    resources: number;
    resourceTemplates: number;
    prompts: number;
  };
}

export interface ServerDetail extends ServerSummary {
  tools: Tool[];
  resources: Resource[];
  resourceTemplates: ResourceTemplate[];
  prompts: Prompt[];
}

export interface WorkbenchSnapshot {
  servers: ServerSummary[];
  environments: EnvironmentSummary[];
  activeEnvironmentId?: string;
}

export interface EnvironmentSummary {
  id: string;
  name: string;
  /** Free-form risk band that drives confirmation prompts. */
  tier: 'dev' | 'qc' | 'prod';
  color: string;
}

export type { HistoryEntry, LogEntry, TraceEntry };

/** Result of an execution, as the webview renders it. */
export interface ExecutionView {
  entry: HistoryEntry;
  ok: boolean;
}
