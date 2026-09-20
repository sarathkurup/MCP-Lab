import * as vscode from 'vscode';
import { registerCommands } from './commands/registerCommands';
import { registerRpcHandlers } from './rpc/handlers';
import { Workbench } from './Workbench';

let workbench: Workbench | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  workbench = new Workbench(context);
  registerRpcHandlers(workbench);
  registerCommands(context, workbench);

  const treeView = vscode.window.createTreeView('mcpWorkbench.servers', {
    treeDataProvider: workbench.tree,
    showCollapseAll: true,
  });

  context.subscriptions.push(treeView, workbench);

  await workbench.reloadServers();
  workbench.logs.log(
    'info',
    `MCP Workbench activated with ${workbench.manager.list().length} server(s)`,
  );

  // Auto-connect runs detached: a slow or unreachable server must not hold up activation.
  void workbench.manager.connectAutoStart();
}

export async function deactivate(): Promise<void> {
  workbench?.dispose();
  workbench = undefined;
}
