import * as vscode from 'vscode';
import { ConnectionManager } from '../core/ConnectionManager';
import { describeTarget } from '../core/config';
import { buildCatalogEntry, searchCatalog, type CatalogEntry, type SearchHit } from '../core/catalog';
import { compareServers, type CompareResult } from '../core/compare';
import { resolveForEnvironment, type Environment } from '../core/environments';
import { ExecutionService } from '../core/execution';
import { HistoryStore, type HistoryEntry } from '../core/history';
import { LogStore } from '../core/logging';
import { Recorder } from '../core/recording';
import type { TestCase, TestSuite } from '../core/testing';
import { TraceStore } from '../core/trace';
import type { ServerDetail, ServerSummary, WorkbenchSnapshot } from '../shared/viewModels';
import { AiService } from './services/AiService';
import { LintDiagnostics } from './services/LintDiagnostics';
import { McpTestController } from './services/McpTestController';
import { OutputChannels } from './services/OutputChannels';
import { TestRepository } from './services/TestRepository';
import { WorkbenchMcpServer } from './services/WorkbenchMcpServer';
import { WorkflowRepository } from './services/WorkflowRepository';
import { EnvironmentStore } from './storage/EnvironmentStore';
import { ServerStore } from './storage/ServerStore';
import { ServersTreeProvider } from './ui/ServersTreeProvider';
import { WorkbenchPanel } from './ui/WorkbenchPanel';

const HISTORY_KEY = 'mcpilot.history.v1';

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
  readonly environments: EnvironmentStore;
  readonly tests: TestRepository;
  readonly lintDiagnostics = new LintDiagnostics();
  readonly ai = new AiService();
  readonly workflows = new WorkflowRepository();
  readonly bridge: WorkbenchMcpServer;
  readonly recorder: Recorder;
  private testController?: McpTestController;

  private readonly disposables: vscode.Disposable[] = [];

  constructor(readonly context: vscode.ExtensionContext) {
    this.trace = new TraceStore(config().traceMaxEntries);
    this.logs.setRedaction(config().redactSecrets);
    this.store = new ServerStore(context);
    this.environments = new EnvironmentStore(context);
    this.tests = new TestRepository();

    this.history = new HistoryStore({
      load: () => context.workspaceState.get<HistoryEntry[]>(HISTORY_KEY, []),
      save: (entries) => void context.workspaceState.update(HISTORY_KEY, entries),
    });

    this.manager = new ConnectionManager({
      logs: this.logs,
      trace: this.trace,
      requestTimeoutMs: () => config().requestTimeoutMs,
      authProvider: (server) => this.store.authHeaders(server),
      maxReconnectAttempts: () => config().maxReconnectAttempts,
    });

    this.execution = new ExecutionService(this.manager, this.history);
    this.recorder = new Recorder(this.execution);
    this.bridge = new WorkbenchMcpServer(this);
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
      this.environments.onDidChange(() => void this.reloadServers()),
      this.tests.onDidChange(() => this.panel.emit('tests-changed')),
      this.workflows.onDidChange(() => this.panel.emit('workflows-changed')),
      asDisposable(
        this.recorder.onDidChange((entries) => this.panel.emit('recording-changed', entries)),
      ),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration('mcpilot.servers') ||
          event.affectsConfiguration('mcpilot.environments')
        ) {
          void this.reloadServers();
        }
        if (event.affectsConfiguration('mcpilot.trace.maxEntries')) {
          this.trace.setCapacity(config().traceMaxEntries);
        }
        if (event.affectsConfiguration('mcpilot.redactSecrets')) {
          this.logs.setRedaction(config().redactSecrets);
        }
      }),
    );
  }

  async reloadServers(): Promise<void> {
    const environmentId = this.environments.active?.id;
    // Configs are resolved through the active environment before the manager
    // ever sees them, so nothing downstream needs to know environments exist.
    await this.manager.sync(
      this.store.list().map((server) => resolveForEnvironment(server, environmentId)),
    );
    this.panel.emit('servers-changed', this.snapshot());
  }

  /** Switching environment drops every live connection: they point elsewhere now. */
  async setEnvironment(id: string): Promise<void> {
    for (const connection of this.manager.list()) {
      if (connection.status === 'connected') {
        await connection.disconnect();
      }
    }
    await this.environments.setActive(id);
    await this.reloadServers();
  }

  get activeEnvironment(): Environment | undefined {
    return this.environments.active;
  }

  snapshot(): WorkbenchSnapshot {
    return {
      servers: this.manager.list().map((connection) => this.summarize(connection.id)!),
      environments: this.environments.list().map((environment) => ({
        id: environment.id,
        name: environment.name,
        tier: environment.tier,
        color: environment.color,
      })),
      activeEnvironmentId: this.environments.active?.id,
    };
  }

  /** Attaches the native Test Explorer once the workspace has been scanned. */
  async startTesting(): Promise<void> {
    await this.workflows.discover();
    await this.tests.discover();
    this.testController = new McpTestController(this);
    this.testController.rebuild();
    this.disposables.push(this.testController);
  }

  /**
   * Picks the server a suite should run against: an explicit name on the test,
   * then the suite, then the only connected server.
   */
  async resolveTestServer(suite: TestSuite, test: TestCase): Promise<string | undefined> {
    const wanted = test.server ?? suite.server;
    const connections = this.manager.list();

    if (wanted) {
      const match = connections.find(
        (c) => c.id === wanted || c.config.name.toLowerCase() === wanted.toLowerCase(),
      );
      if (!match) {
        return undefined;
      }
      if (match.status !== 'connected') {
        await match.connect().catch(() => undefined);
      }
      return match.status === 'connected' ? match.id : undefined;
    }

    const connected = connections.filter((c) => c.status === 'connected');
    return connected.length === 1 ? connected[0].id : connected[0]?.id;
  }

  /** Maps a server name (as a workflow or test writes it) to a connected id. */
  resolveServerByName(name: string | undefined): string | undefined {
    if (!name) {
      return undefined;
    }
    const match = this.manager
      .list()
      .find((c) => c.id === name || c.config.name.toLowerCase() === name.toLowerCase());
    return match?.id;
  }

  /** The catalog view: one card per server, with health derived from usage. */
  catalog(): CatalogEntry[] {
    return this.manager.list().map((connection) =>
      buildCatalogEntry({
        config: connection.config,
        status: connection.status,
        lastError: connection.lastError,
        serverVersion: connection.serverInfo?.version,
        protocolVersion: connection.protocolVersion,
        target: describeTarget(connection.config),
        tools: connection.catalog.tools,
        resources: connection.catalog.resources,
        prompts: connection.catalog.prompts,
        stats: this.history.stats(connection.id),
      }),
    );
  }

  /** Searches every connected server at once. */
  search(query: string): SearchHit[] {
    return searchCatalog(
      this.manager.list().map((connection) => ({
        serverId: connection.id,
        serverName: connection.config.name,
        metadata: connection.config.metadata,
        tools: connection.catalog.tools,
        resources: connection.catalog.resources,
        prompts: connection.catalog.prompts,
      })),
      query,
    );
  }

  /** Diffs two connected servers, typically the same server in two environments. */
  async compare(leftId: string, rightId: string): Promise<CompareResult> {
    const left = this.manager.get(leftId);
    const right = this.manager.get(rightId);
    if (!left || !right) {
      throw new Error('Both servers must be configured before comparing them.');
    }

    for (const connection of [left, right]) {
      if (connection.status !== 'connected') {
        await connection.connect();
      }
    }

    return compareServers(
      {
        label: left.config.name,
        serverInfo: left.serverInfo,
        protocolVersion: left.protocolVersion,
        tools: left.catalog.tools,
        resources: left.catalog.resources,
        prompts: left.catalog.prompts,
      },
      {
        label: right.config.name,
        serverInfo: right.serverInfo,
        protocolVersion: right.protocolVersion,
        tools: right.catalog.tools,
        resources: right.catalog.resources,
        prompts: right.catalog.prompts,
      },
    );
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
      environmentId: connection.config.environmentId,
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
    this.environments.dispose();
    this.tests.dispose();
    this.workflows.dispose();
    this.bridge.dispose();
    this.recorder.dispose();
    this.lintDiagnostics.dispose();
    this.panel.dispose();
    void this.manager.disposeAll();
  }
}

export function config(): {
  requestTimeoutMs: number;
  traceMaxEntries: number;
  maxReconnectAttempts: number;
  redactSecrets: boolean;
} {
  const settings = vscode.workspace.getConfiguration('mcpilot');
  return {
    requestTimeoutMs: settings.get<number>('requestTimeoutMs', 30_000),
    traceMaxEntries: settings.get<number>('trace.maxEntries', 2000),
    maxReconnectAttempts: settings.get<number>('maxReconnectAttempts', 5),
    redactSecrets: settings.get<boolean>('redactSecrets', true),
  };
}

function asDisposable(d: { dispose(): void }): vscode.Disposable {
  return new vscode.Disposable(() => d.dispose());
}
