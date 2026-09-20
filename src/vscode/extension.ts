import * as vscode from 'vscode';
import { ConnectionManager } from '../core/ConnectionManager';
import { LogStore } from '../core/logging';
import { TraceStore } from '../core/trace';
import { registerCommands } from './commands/registerCommands';
import { OutputChannels } from './services/OutputChannels';
import { ServerStore } from './storage/ServerStore';
import { ServersTreeProvider } from './ui/ServersTreeProvider';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logs = new LogStore();
  const trace = new TraceStore(readConfig().traceMaxEntries);
  const store = new ServerStore(context);

  const manager = new ConnectionManager({
    logs,
    trace,
    requestTimeoutMs: () => readConfig().requestTimeoutMs,
    authProvider: (config) => store.authHeaders(config),
  });

  const channels = new OutputChannels(logs, trace);
  const tree = new ServersTreeProvider(manager);

  const treeView = vscode.window.createTreeView('mcpWorkbench.servers', {
    treeDataProvider: tree,
    showCollapseAll: true,
  });

  const reloadServers = async (): Promise<void> => {
    await manager.sync(store.list());
  };

  registerCommands(context, { manager, store, tree, channels, reloadServers });

  context.subscriptions.push(
    treeView,
    tree,
    channels,
    store,
    store.onDidChange(() => void reloadServers()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('mcpWorkbench.servers')) {
        void reloadServers();
      }
      if (event.affectsConfiguration('mcpWorkbench.trace.maxEntries')) {
        trace.setCapacity(readConfig().traceMaxEntries);
      }
    }),
    { dispose: () => void manager.disposeAll() },
  );

  await reloadServers();
  logs.log('info', `MCP Workbench activated with ${manager.list().length} server(s)`);

  // Auto-connect runs detached: a slow or unreachable server must not hold up activation.
  void manager.connectAutoStart();
}

export async function deactivate(): Promise<void> {
  // Connections are torn down through context.subscriptions.
}

function readConfig(): { requestTimeoutMs: number; traceMaxEntries: number } {
  const config = vscode.workspace.getConfiguration('mcpWorkbench');
  return {
    requestTimeoutMs: config.get<number>('requestTimeoutMs', 30_000),
    traceMaxEntries: config.get<number>('trace.maxEntries', 2000),
  };
}
