import * as vscode from 'vscode';
import { registerCommands } from './commands/registerCommands';
import { registerRpcHandlers } from './rpc/handlers';
import { registerChatParticipant } from './services/ChatParticipant';
import { Workbench } from './Workbench';

let workbench: Workbench | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  workbench = new Workbench(context);
  registerRpcHandlers(workbench);
  registerCommands(context, workbench);
  registerChatParticipant(context, workbench);

  const treeView = vscode.window.createTreeView('mcpilot.servers', {
    treeDataProvider: workbench.tree,
    showCollapseAll: true,
  });

  context.subscriptions.push(treeView, workbench);

  await workbench.reloadServers();
  workbench.logs.log(
    'info',
    `MCPilot activated with ${workbench.manager.list().length} server(s)`,
  );

  // Auto-connect and workspace test discovery both run detached: neither a slow
  // server nor a large workspace should hold up activation.
  void workbench.manager.connectAutoStart();
  void workbench.startTesting();
}

export async function deactivate(): Promise<void> {
  workbench?.dispose();
  workbench = undefined;
}
