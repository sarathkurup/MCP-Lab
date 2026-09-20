import * as vscode from 'vscode';
import { generateDocs } from '../../core/docs';
import type { TreeNode } from '../ui/ServersTreeProvider';
import type { Workbench } from '../Workbench';
import { resolveServerId } from './helpers';

/** Documentation, security and comparison reports. */

export async function generateDocumentation(
  workbench: Workbench,
  arg?: TreeNode | { serverId: string },
): Promise<void> {
  const node = arg as TreeNode | undefined;
  const serverId =
    (arg as { serverId?: string })?.serverId ??
    (await resolveServerId(workbench, node, 'Document which server?'));
  if (!serverId) {
    return;
  }

  const connection = workbench.manager.get(serverId);
  if (!connection || connection.status !== 'connected') {
    throw new Error('Connect the server first: documentation is generated from the live catalog.');
  }

  const markdown = generateDocs({
    name: connection.config.name,
    serverInfo: connection.serverInfo,
    protocolVersion: connection.protocolVersion,
    instructions: connection.instructions,
    capabilities: connection.capabilities,
    tools: connection.catalog.tools,
    resources: connection.catalog.resources,
    resourceTemplates: connection.catalog.resourceTemplates,
    prompts: connection.catalog.prompts,
  });

  const choice = await vscode.window.showQuickPick(
    [
      { label: 'Open in an editor', value: 'open' as const },
      { label: 'Save to a file…', value: 'save' as const },
    ],
    { placeHolder: `Documentation for ${connection.config.name}` },
  );
  if (!choice) {
    return;
  }

  if (choice.value === 'open') {
    const doc = await vscode.workspace.openTextDocument({
      content: markdown,
      language: 'markdown',
    });
    await vscode.window.showTextDocument(doc, { preview: false });
    return;
  }

  const target = await vscode.window.showSaveDialog({
    filters: { Markdown: ['md'] },
    defaultUri: vscode.workspace.workspaceFolders?.[0]
      ? vscode.Uri.joinPath(
          vscode.workspace.workspaceFolders[0].uri,
          `${slug(connection.config.name)}.md`,
        )
      : undefined,
  });
  if (!target) {
    return;
  }
  await vscode.workspace.fs.writeFile(target, Buffer.from(markdown, 'utf8'));
  void vscode.window.showInformationMessage(`Wrote ${vscode.workspace.asRelativePath(target)}`);
}

export async function securityScan(workbench: Workbench, node?: TreeNode): Promise<void> {
  const serverId = await resolveServerId(workbench, node, 'Scan which server?');
  if (!serverId) {
    return;
  }
  workbench.focus({ serverId, view: 'security' });
}

export async function compareServersCommand(workbench: Workbench): Promise<void> {
  const servers = workbench.manager.list();
  if (servers.length < 2) {
    throw new Error('Comparison needs two configured servers.');
  }

  const left = await vscode.window.showQuickPick(
    servers.map((connection) => ({ label: connection.config.name, value: connection.id })),
    { placeHolder: 'Compare from…' },
  );
  if (!left) {
    return;
  }

  const right = await vscode.window.showQuickPick(
    servers
      .filter((connection) => connection.id !== left.value)
      .map((connection) => ({ label: connection.config.name, value: connection.id })),
    { placeHolder: 'Compare to…' },
  );
  if (!right) {
    return;
  }

  workbench.focus({ view: 'compare' });
  // The view reads its own selection, so seed it and let it run the comparison.
  workbench.panel.emit('compare-target', { leftId: left.value, rightId: right.value });
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'mcp-server';
}
