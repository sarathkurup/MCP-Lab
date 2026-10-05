import * as vscode from 'vscode';
import { registerCommands } from './commands/registerCommands';
import { registerRpcHandlers } from './rpc/handlers';
import { AUTH_PROVIDER_ID, McpLabAuthenticationProvider } from './services/AuthenticationProvider';
import { registerChatParticipant } from './services/ChatParticipant';
import { McpLab } from './McpLab';

let lab: McpLab | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  lab = new McpLab(context);
  registerRpcHandlers(lab);
  registerCommands(context, lab);
  registerChatParticipant(context, lab);

  // MCP project sign-ins appear in the Accounts menu like any other account.
  const authProvider = new McpLabAuthenticationProvider(lab);
  context.subscriptions.push(
    authProvider,
    vscode.authentication.registerAuthenticationProvider(AUTH_PROVIDER_ID, 'MCP Lab', authProvider, {
      supportsMultipleAccounts: true,
    }),
  );

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
  void lab.oauth.announceRedirectUri(lab.projectConnections().length);

  // Auto-connect and workspace test discovery both run detached: neither a slow
  // server nor a large workspace should hold up activation.
  void lab.manager.connectAutoStart();
  void lab.startTesting();
}

export async function deactivate(): Promise<void> {
  lab?.dispose();
  lab = undefined;
}
