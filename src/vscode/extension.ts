import * as vscode from 'vscode';
import { registerCommands } from './commands/registerCommands';
import { registerRpcHandlers } from './rpc/handlers';
import { registerChatParticipant } from './services/ChatParticipant';
import { McpLab } from './McpLab';

let lab: McpLab | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  lab = new McpLab(context);
  registerRpcHandlers(lab);
  registerCommands(context, lab);
  registerChatParticipant(context, lab);

  const treeView = vscode.window.createTreeView('mcplab.servers', {
    treeDataProvider: lab.tree,
    showCollapseAll: true,
  });

  context.subscriptions.push(treeView, lab);

  await lab.reloadServers();
  lab.logs.log(
    'info',
    `MCP Lab activated with ${lab.manager.list().length} server(s)`,
  );

  // Auto-connect and workspace test discovery both run detached: neither a slow
  // server nor a large workspace should hold up activation.
  void lab.manager.connectAutoStart();
  void lab.startTesting();
}

export async function deactivate(): Promise<void> {
  lab?.dispose();
  lab = undefined;
}
