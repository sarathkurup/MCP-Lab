import * as vscode from 'vscode';
import { describeTarget } from '../../core/config';
import type { TreeNode } from '../ui/ServersTreeProvider';
import type { Workbench } from '../Workbench';

/**
 * Resolves the server a command should act on: the tree node it was invoked
 * from, the only configured server, or a quick pick.
 */
export async function resolveServerId(
  workbench: Workbench,
  node: TreeNode | undefined,
  placeHolder: string,
): Promise<string | undefined> {
  if (node?.serverId) {
    return node.serverId;
  }

  const connections = workbench.manager.list();
  if (connections.length === 0) {
    throw new Error('No servers configured yet. Run "MCP: Add Server" first.');
  }
  if (connections.length === 1) {
    return connections[0].id;
  }

  const picked = await vscode.window.showQuickPick(
    connections.map((connection) => ({
      label: connection.config.name,
      description: connection.status,
      detail: describeTarget(connection.config),
      value: connection.id,
    })),
    { placeHolder },
  );
  return picked?.value;
}

export async function openJsonDocument(payload: unknown): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({
    content: JSON.stringify(payload, null, 2),
    language: 'json',
  });
  await vscode.window.showTextDocument(doc, { preview: true });
}

export async function openMarkdownDocument(content: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({ content, language: 'markdown' });
  await vscode.window.showTextDocument(doc, { preview: true });
}
