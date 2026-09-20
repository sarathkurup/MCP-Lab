import * as vscode from 'vscode';
import { ConnectionManager } from '../core/ConnectionManager';
import { describeTarget } from '../core/config';
import { ExecutionService } from '../core/execution';
import { HistoryStore, type HistoryEntry } from '../core/history';
import { LogStore } from '../core/logging';
import { TraceStore } from '../core/trace';
import type { ServerDetail, ServerSummary, WorkbenchSnapshot } from '../shared/viewModels';
import { OutputChannels } from './services/OutputChannels';
import { ServerStore } from './storage/ServerStore';
import { ServersTreeProvider } from './ui/ServersTreeProvider';
import { WorkbenchPanel } from './ui/WorkbenchPanel';

const HISTORY_KEY = 'mcpWorkbench.history.v1';

/**
 * Composition root. Owns every long-lived service and is the only place that
 * knows how the core engine, the VS Code UI and the webview fit together.
 */
export class Workbench implements vscode.Disposable {
  readonly logs = new LogStore();
  readonly trace: TraceStore;
  readonly history: HistoryStore;
  readonly store: ServerStore;
  readonly manager: ConnectionManager;
  readonly execution: ExecutionService;
  readonly channels: OutputChannels;
  readonly tree: ServersTreeProvider;
  readonly panel: WorkbenchPanel;

  private readonly disposables: vscode.Disposable[] = [];

  constructor(readonly context: vscode.ExtensionContext) {
    this.trace = new TraceStore(config().traceMaxEntries);
    this.store = new ServerStore(context);

    this.history = new HistoryStore({
      load: () => context.workspaceState.get<HistoryEntry[]>(HISTORY_KEY, []),
      save: (entries) => void context.workspaceState.update(HISTORY_KEY, entries),
    });

    this.manager = new ConnectionManager({
      logs: this.logs,
      trace: this.trace,
      requestTimeoutMs: () => config().requestTimeoutMs,
      authProvider: (server) => this.store.authHeaders(server),
    });

    this.execution = new ExecutionService(this.manager, this.history);
    this.channels = new OutputChannels(this.logs, this.trace);
    this.tree = new ServersTreeProvider(this.manager);
    this.panel = WorkbenchPanel.register(context);

    this.wireEvents();
  }

  private wireEvents(): void {
    const push = () => this.panel.emit('servers-changed', this.snapshot());

    this.disposables.push(
      asDisposable(this.manager.onDidChangeStatus(push)),
      asDisposable(this.manager.onDidChangeCatalog(push)),
      asDisposable(this.manager.onDidChangeServers(push)),
      asDisposable(this.trace.onDidTrace((entry) => this.panel.emit('trace', entry))),
      asDisposable(this.logs.onDidLog((entry) => this.panel.emit('log', entry))),
      asDisposable(this.history.onDidChange(() => this.panel.emit('history-changed'))),
      this.store.onDidChange(() => void this.reloadServers()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('mcpWorkbench.servers')) {
          void this.reloadServers();
        }
        if (event.affectsConfiguration('mcpWorkbench.trace.maxEntries')) {
          this.trace.setCapacity(config().traceMaxEntries);
        }
      }),
    );
  }

  async reloadServers(): Promise<void> {
    await this.manager.sync(this.store.list());
    this.panel.emit('servers-changed', this.snapshot());
  }

  snapshot(): WorkbenchSnapshot {
    return {
      servers: this.manager.list().map((connection) => this.summarize(connection.id)!),
      environments: [],
    };
  }

  summarize(serverId: string): ServerSummary | undefined {
    const connection = this.manager.get(serverId);
    if (!connection) {
      return undefined;
    }
    const catalog = connection.catalog;
    return {
      id: connection.id,
      name: connection.config.name,
      transport: connection.config.transport,
      target: describeTarget(connection.config),
      status: connection.status,
      error: connection.lastError,
      source: connection.config.source,
      serverInfo: connection.serverInfo
        ? {
            name: connection.serverInfo.name,
            version: connection.serverInfo.version,
            title: connection.serverInfo.title,
          }
        : undefined,
      protocolVersion: connection.protocolVersion,
      capabilities: connection.capabilities,
      instructions: connection.instructions,
      counts: {
        tools: catalog.tools.length,
        resources: catalog.resources.length,
        resourceTemplates: catalog.resourceTemplates.length,
        prompts: catalog.prompts.length,
      },
    };
  }

  detail(serverId: string): ServerDetail {
    const summary = this.summarize(serverId);
    if (!summary) {
      throw new Error(`Unknown server "${serverId}"`);
    }
    const catalog = this.manager.get(serverId)!.catalog;
    return {
      ...summary,
      tools: catalog.tools,
      resources: catalog.resources,
      resourceTemplates: catalog.resourceTemplates,
      prompts: catalog.prompts,
    };
  }

  /** Opens the panel focused on a particular server and item. */
  focus(target: {
    serverId?: string;
    view?: string;
    selection?: { kind: 'tool' | 'resource' | 'prompt'; name: string };
  }): void {
    this.panel.reveal();
    // The view may still be booting, so the focus event is sent after a tick.
    setTimeout(() => this.panel.emit('focus', target), 120);
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.tree.dispose();
    this.channels.dispose();
    this.store.dispose();
    this.panel.dispose();
    void this.manager.disposeAll();
  }
}

export function config(): { requestTimeoutMs: number; traceMaxEntries: number } {
  const settings = vscode.workspace.getConfiguration('mcpWorkbench');
  return {
    requestTimeoutMs: settings.get<number>('requestTimeoutMs', 30_000),
    traceMaxEntries: settings.get<number>('trace.maxEntries', 2000),
  };
}

function asDisposable(d: { dispose(): void }): vscode.Disposable {
  return new vscode.Disposable(() => d.dispose());
}
