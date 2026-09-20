import * as vscode from 'vscode';
import type { ConnectionManager } from '../../core/ConnectionManager';
import { describeTarget } from '../../core/config';
import type { McpConnection } from '../../core/McpConnection';
import type { Prompt, Resource, ResourceTemplate, Tool } from '../../core/protocol';

export type TreeNode = ServerNode | GroupNode | ToolNode | ResourceNode | PromptNode;

export interface ServerNode {
  kind: 'server';
  serverId: string;
}

export interface GroupNode {
  kind: 'group';
  serverId: string;
  group: 'tools' | 'resources' | 'templates' | 'prompts';
}

export interface ToolNode {
  kind: 'tool';
  serverId: string;
  tool: Tool;
}

export interface ResourceNode {
  kind: 'resource';
  serverId: string;
  resource: Resource | ResourceTemplate;
}

export interface PromptNode {
  kind: 'prompt';
  serverId: string;
  prompt: Prompt;
}

export class ServersTreeProvider
  implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable
{
  private readonly changed = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly manager: ConnectionManager) {
    this.disposables.push(
      asDisposable(manager.onDidChangeStatus(() => this.refresh())),
      asDisposable(manager.onDidChangeCatalog(() => this.refresh())),
      asDisposable(manager.onDidChangeServers(() => this.refresh())),
    );
  }

  refresh(node?: TreeNode): void {
    this.changed.fire(node);
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!node) {
      return this.manager.list().map((c) => ({ kind: 'server', serverId: c.id }));
    }

    const connection = this.manager.get(node.serverId);
    if (!connection) {
      return [];
    }

    if (node.kind === 'server') {
      if (connection.status !== 'connected') {
        return [];
      }
      const { tools, resources, resourceTemplates, prompts } = connection.catalog;
      const groups: GroupNode[] = [];
      if (connection.capabilities?.tools || tools.length) {
        groups.push({ kind: 'group', serverId: node.serverId, group: 'tools' });
      }
      if (connection.capabilities?.resources || resources.length) {
        groups.push({ kind: 'group', serverId: node.serverId, group: 'resources' });
      }
      if (resourceTemplates.length) {
        groups.push({ kind: 'group', serverId: node.serverId, group: 'templates' });
      }
      if (connection.capabilities?.prompts || prompts.length) {
        groups.push({ kind: 'group', serverId: node.serverId, group: 'prompts' });
      }
      return groups;
    }

    if (node.kind === 'group') {
      const catalog = connection.catalog;
      switch (node.group) {
        case 'tools':
          return catalog.tools.map((tool) => ({
            kind: 'tool' as const,
            serverId: node.serverId,
            tool,
          }));
        case 'resources':
          return catalog.resources.map((resource) => ({
            kind: 'resource' as const,
            serverId: node.serverId,
            resource,
          }));
        case 'templates':
          return catalog.resourceTemplates.map((resource) => ({
            kind: 'resource' as const,
            serverId: node.serverId,
            resource,
          }));
        case 'prompts':
          return catalog.prompts.map((prompt) => ({
            kind: 'prompt' as const,
            serverId: node.serverId,
            prompt,
          }));
      }
    }

    return [];
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    const connection = this.manager.get(node.serverId);
    switch (node.kind) {
      case 'server':
        return connection ? serverItem(connection) : new vscode.TreeItem('(missing server)');
      case 'group':
        return groupItem(node, connection);
      case 'tool':
        return attachOpenCommand(toolItem(node), node);
      case 'resource':
        return attachOpenCommand(resourceItem(node), node);
      case 'prompt':
        return attachOpenCommand(promptItem(node), node);
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.changed.dispose();
  }
}

function serverItem(connection: McpConnection): vscode.TreeItem {
  const item = new vscode.TreeItem(
    connection.config.name,
    connection.status === 'connected'
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.None,
  );

  const info = connection.serverInfo;
  item.description =
    connection.status === 'connected'
      ? `${info?.name ?? 'connected'}${info?.version ? ` v${info.version}` : ''}`
      : connection.status === 'error'
        ? 'error'
        : connection.status;

  item.iconPath = new vscode.ThemeIcon(
    connection.status === 'connected'
      ? 'circle-filled'
      : connection.status === 'connecting'
        ? 'loading~spin'
        : connection.status === 'error'
          ? 'error'
          : 'circle-outline',
    connection.status === 'connected'
      ? new vscode.ThemeColor('testing.iconPassed')
      : connection.status === 'error'
        ? new vscode.ThemeColor('testing.iconFailed')
        : undefined,
  );

  item.contextValue = `server:${connection.status}`;
  item.id = `server:${connection.id}`;

  const lines = [
    `**${connection.config.name}**`,
    '',
    `- Transport: \`${connection.config.transport}\``,
    `- Target: \`${describeTarget(connection.config)}\``,
    `- Status: \`${connection.status}\``,
  ];
  if (connection.protocolVersion) {
    lines.push(`- Protocol: \`${connection.protocolVersion}\``);
  }
  if (connection.config.source === 'settings') {
    lines.push('- Defined in workspace settings');
  }
  if (connection.lastError) {
    lines.push('', `⚠️ ${connection.lastError}`);
  }
  item.tooltip = new vscode.MarkdownString(lines.join('\n'));
  return item;
}

function groupItem(node: GroupNode, connection?: McpConnection): vscode.TreeItem {
  const catalog = connection?.catalog;
  const meta = {
    tools: { label: 'Tools', icon: 'tools', count: catalog?.tools.length ?? 0 },
    resources: { label: 'Resources', icon: 'file-submodule', count: catalog?.resources.length ?? 0 },
    templates: {
      label: 'Resource Templates',
      icon: 'symbol-namespace',
      count: catalog?.resourceTemplates.length ?? 0,
    },
    prompts: { label: 'Prompts', icon: 'comment-discussion', count: catalog?.prompts.length ?? 0 },
  }[node.group];

  const item = new vscode.TreeItem(
    meta.label,
    meta.count > 0
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None,
  );
  item.description = String(meta.count);
  item.iconPath = new vscode.ThemeIcon(meta.icon);
  item.contextValue = `group:${node.group}`;
  item.id = `group:${node.serverId}:${node.group}`;
  return item;
}

function toolItem(node: ToolNode): vscode.TreeItem {
  const { tool } = node;
  const item = new vscode.TreeItem(tool.name, vscode.TreeItemCollapsibleState.None);
  item.description = tool.title ?? firstLine(tool.description);
  item.contextValue = 'tool';
  item.id = `tool:${node.serverId}:${tool.name}`;

  const annotations = tool.annotations ?? {};
  item.iconPath = new vscode.ThemeIcon(
    annotations.destructiveHint
      ? 'warning'
      : annotations.readOnlyHint
        ? 'eye'
        : 'symbol-method',
    annotations.destructiveHint ? new vscode.ThemeColor('list.warningForeground') : undefined,
  );

  const required = tool.inputSchema?.required ?? [];
  const params = Object.keys(tool.inputSchema?.properties ?? {});
  const lines = [`**${tool.name}**`, '', tool.description ?? '_No description_', ''];
  lines.push(
    params.length
      ? `Parameters: ${params
          .map((p) => (required.includes(p) ? `\`${p}*\`` : `\`${p}\``))
          .join(', ')}`
      : 'Parameters: _none_',
  );
  if (annotations.destructiveHint) {
    lines.push('', '⚠️ Annotated as **destructive**');
  }
  if (annotations.readOnlyHint) {
    lines.push('', '👁️ Annotated as **read-only**');
  }
  item.tooltip = new vscode.MarkdownString(lines.join('\n'));
  return item;
}

function resourceItem(node: ResourceNode): vscode.TreeItem {
  const resource = node.resource;
  const uri = 'uri' in resource ? resource.uri : resource.uriTemplate;
  const item = new vscode.TreeItem(resource.name || uri, vscode.TreeItemCollapsibleState.None);
  item.description = uri;
  item.contextValue = 'resource';
  item.id = `resource:${node.serverId}:${uri}`;
  item.iconPath = new vscode.ThemeIcon('uriTemplate' in resource ? 'symbol-namespace' : 'file');
  item.tooltip = new vscode.MarkdownString(
    [
      `**${resource.name || uri}**`,
      '',
      `\`${uri}\``,
      '',
      resource.description ?? '_No description_',
      resource.mimeType ? `\n\nMIME: \`${resource.mimeType}\`` : '',
    ].join('\n'),
  );
  return item;
}

function promptItem(node: PromptNode): vscode.TreeItem {
  const { prompt } = node;
  const item = new vscode.TreeItem(prompt.name, vscode.TreeItemCollapsibleState.None);
  item.description = prompt.title ?? firstLine(prompt.description);
  item.contextValue = 'prompt';
  item.id = `prompt:${node.serverId}:${prompt.name}`;
  item.iconPath = new vscode.ThemeIcon('comment');

  const args = prompt.arguments ?? [];
  item.tooltip = new vscode.MarkdownString(
    [
      `**${prompt.name}**`,
      '',
      prompt.description ?? '_No description_',
      '',
      args.length
        ? `Arguments: ${args
            .map((a) => (a.required ? `\`${a.name}*\`` : `\`${a.name}\``))
            .join(', ')}`
        : 'Arguments: _none_',
    ].join('\n'),
  );
  return item;
}

function firstLine(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const line = value.split('\n')[0].trim();
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}

function asDisposable(d: { dispose(): void }): vscode.Disposable {
  return new vscode.Disposable(() => d.dispose());
}

/** Clicking a leaf opens it in the Workbench panel. */
export function attachOpenCommand(item: vscode.TreeItem, node: TreeNode): vscode.TreeItem {
  item.command = {
    command: 'mcplab.openItem',
    title: 'Open in MCP Lab',
    arguments: [node],
  };
  return item;
}
