import * as vscode from 'vscode';
import type { ConnectionManager } from '../../core/ConnectionManager';
import { describeTarget } from '../../core/config';
import { classifyTool } from '../../core/environments';
import type { McpConnection } from '../../core/McpConnection';
import { sanitizeUrl } from '../../core/oauth';
import { blockingIssues } from '../../core/projects';
import type { Prompt, Resource, ResourceTemplate, Tool } from '../../core/protocol';
import { describeToolInput } from '../../core/schema';

export type TreeNode =
  | ServerNode
  | GroupNode
  | ToolNode
  | ResourceNode
  | PromptNode
  | InfoNode
  | ParamNode;

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

/** A fact about a server rather than something it exposes: account, endpoint, a problem. */
export interface InfoNode {
  kind: 'info';
  serverId: string;
  key: string;
  label: string;
  description?: string;
  tooltip?: string;
  icon: string;
  color?: string;
  command?: vscode.Command;
}

/** One parameter of a tool's input schema, or a problem reading that schema. */
export interface ParamNode {
  kind: 'param';
  serverId: string;
  toolName: string;
  label: string;
  description?: string;
  tooltip?: string;
  required: boolean;
  problem: boolean;
}

export interface TreeAuthStatus {
  signedIn: boolean;
  account?: string;
  expiresAt?: number;
  refreshable?: boolean;
}

/** What the tree needs to know about sign-in and selection; undefined status means not an OAuth server. */
export interface TreeContext {
  authStatus(serverId: string): TreeAuthStatus | undefined;
  selectedProject(): string | undefined;
}

export class ServersTreeProvider
  implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable
{
  private readonly changed = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly manager: ConnectionManager,
    private readonly context?: TreeContext,
  ) {
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
      const info = this.infoNodes(connection);
      if (connection.status !== 'connected') {
        return info;
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
      return [...info, ...groups];
    }

    if (node.kind === 'group') {
      const catalog = connection.catalog;
      const failure = (part: 'tools' | 'resources' | 'resourceTemplates' | 'prompts'): InfoNode[] => {
        const message = catalog.errors?.[part];
        return message
          ? [
              {
                kind: 'info',
                serverId: node.serverId,
                key: `failed:${part}`,
                label: message,
                tooltip: `${message}\n\nThe list is empty because the request failed, not because the server has none.`,
                icon: 'error',
                color: 'testing.iconFailed',
                command: { command: 'mcplab.refreshTools', title: 'Retry', arguments: [{ kind: 'server', serverId: node.serverId }] },
              },
            ]
          : [];
      };
      switch (node.group) {
        case 'tools':
          return [
            ...failure('tools'),
            ...catalog.tools.map((tool) => ({ kind: 'tool' as const, serverId: node.serverId, tool })),
          ];
        case 'resources':
          return [
            ...failure('resources'),
            ...catalog.resources.map((resource) => ({ kind: 'resource' as const, serverId: node.serverId, resource })),
          ];
        case 'templates':
          return [
            ...failure('resourceTemplates'),
            ...catalog.resourceTemplates.map((resource) => ({ kind: 'resource' as const, serverId: node.serverId, resource })),
          ];
        case 'prompts':
          return [
            ...failure('prompts'),
            ...catalog.prompts.map((prompt) => ({ kind: 'prompt' as const, serverId: node.serverId, prompt })),
          ];
      }
    }

    if (node.kind === 'tool') {
      return paramNodes(node);
    }

    return [];
  }

  /** Account, endpoint and configuration problems, for project and OAuth servers. */
  private infoNodes(connection: McpConnection): InfoNode[] {
    const config = connection.config;
    const project = config.project;
    const auth = this.context?.authStatus(connection.id);
    if (!project && !auth) {
      return [];
    }
    const nodes: InfoNode[] = [];
    const serverArg = [{ kind: 'server', serverId: connection.id }];

    if (project) {
      for (const issue of blockingIssues(project)) {
        nodes.push({
          kind: 'info',
          serverId: connection.id,
          key: `issue:${issue.key}`,
          label: issue.message,
          description: issue.configKeys?.length ? `set ${issue.configKeys.join(' or ')}` : undefined,
          tooltip: 'This project cannot connect until this is fixed. Run "MCP: Show Authentication Diagnostics" for everything that was checked.',
          icon: 'error',
          color: 'testing.iconFailed',
          command: { command: 'mcplab.showAuthDiagnostics', title: 'Show diagnostics', arguments: serverArg },
        });
      }
      if (project.pendingApproval?.length) {
        nodes.push({
          kind: 'info',
          serverId: connection.id,
          key: 'approval',
          label: 'Workspace settings need your approval',
          description: project.pendingApproval.join(', '),
          tooltip: 'This workspace sets where credentials are sent. Connect to review and approve it.',
          icon: 'shield',
          color: 'list.warningForeground',
          command: { command: 'mcplab.connect', title: 'Review', arguments: serverArg },
        });
      }
    }

    if (auth) {
      if (auth.signedIn) {
        nodes.push({
          kind: 'info',
          serverId: connection.id,
          key: 'account',
          label: auth.account ?? 'Signed in',
          description: expiryText(auth),
          tooltip: auth.refreshable
            ? 'Signed in. The access token is refreshed automatically before it expires.'
            : 'Signed in. There is no refresh token, so you will be asked to sign in again when it expires.',
          icon: 'account',
          color: 'testing.iconPassed',
        });
      } else {
        nodes.push({
          kind: 'info',
          serverId: connection.id,
          key: 'account',
          label: 'Not signed in',
          description: 'click to sign in',
          tooltip: 'Opens your browser to sign in with this project\'s identity provider.',
          icon: 'sign-in',
          command: { command: 'mcplab.signIn', title: 'Sign In', arguments: serverArg },
        });
      }
    }

    if (config.url) {
      nodes.push({
        kind: 'info',
        serverId: connection.id,
        key: 'endpoint',
        label: 'Endpoint',
        description: sanitizeUrl(config.url),
        tooltip: 'The MCP transport endpoint. Query values are hidden.',
        icon: 'globe',
      });
    }
    return nodes;
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    const connection = this.manager.get(node.serverId);
    switch (node.kind) {
      case 'server':
        return connection
          ? serverItem(connection, this.context?.authStatus(connection.id), this.context?.selectedProject() === connection.id)
          : new vscode.TreeItem('(missing server)');
      case 'group':
        return groupItem(node, connection);
      case 'tool':
        return attachOpenCommand(toolItem(node), node);
      case 'resource':
        return attachOpenCommand(resourceItem(node), node);
      case 'prompt':
        return attachOpenCommand(promptItem(node), node);
      case 'info':
        return infoItem(node);
      case 'param':
        return paramItem(node);
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.changed.dispose();
  }
}

function expiryText(auth: TreeAuthStatus): string | undefined {
  if (auth.expiresAt === undefined) return auth.refreshable ? 'auto-refresh' : undefined;
  const minutes = Math.round((auth.expiresAt - Date.now()) / 60_000);
  if (minutes <= 0) return auth.refreshable ? 'token refreshes on next use' : 'expired';
  return minutes < 90 ? `token ${minutes} min` : `token ${Math.round(minutes / 60)} h`;
}

function serverItem(connection: McpConnection, auth: TreeAuthStatus | undefined, selected: boolean): vscode.TreeItem {
  const hasDetails = connection.status === 'connected' || !!auth || !!connection.config.project;
  const item = new vscode.TreeItem(
    connection.config.name,
    connection.status === 'connected'
      ? vscode.TreeItemCollapsibleState.Expanded
      : hasDetails
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
  );

  const info = connection.serverInfo;
  const status =
    connection.status === 'connected'
      ? `${info?.name ?? 'connected'}${info?.version ? ` v${info.version}` : ''}`
      : connection.status;
  item.description = selected ? `★ ${status}` : status;

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

  // `server:<status>` first, so menus can match the status alone with a prefix.
  item.contextValue = `server:${connection.status}${auth ? `:oauth:${auth.signedIn ? 'in' : 'out'}` : ''}`;
  item.id = `server:${connection.id}`;

  const lines = [
    `**${connection.config.name}**${selected ? ' — selected project' : ''}`,
    '',
    `- Transport: \`${connection.config.transport}\``,
    `- Target: \`${connection.config.url ? sanitizeUrl(connection.config.url) : describeTarget(connection.config)}\``,
    `- Status: \`${connection.status}\``,
  ];
  if (auth) {
    lines.push(`- Authentication: ${auth.signedIn ? `signed in as ${auth.account ?? 'unknown'}` : 'not signed in'}`);
  }
  if (connection.protocolVersion) {
    lines.push(`- Protocol: \`${connection.protocolVersion}\``);
  }
  if (connection.status === 'connected') {
    lines.push(`- Tools: ${connection.catalog.errors?.tools ? 'tools/list failed' : connection.catalog.tools.length}`);
  }
  if (connection.config.source === 'settings') {
    lines.push('- Defined in workspace settings');
  }
  if (connection.config.source === 'project') {
    lines.push('- MCP project');
  }
  if (connection.lastError) {
    lines.push('', `⚠️ ${connection.lastError}`);
  }
  // Server-provided and configured text is rendered as text, never as markup.
  item.tooltip = markdown(lines.join('\n'));
  return item;
}

function groupItem(node: GroupNode, connection?: McpConnection): vscode.TreeItem {
  const catalog = connection?.catalog;
  const meta = {
    tools: { label: 'Tools', icon: 'tools', count: catalog?.tools.length ?? 0, failed: catalog?.errors?.tools },
    resources: { label: 'Resources', icon: 'file-submodule', count: catalog?.resources.length ?? 0, failed: catalog?.errors?.resources },
    templates: {
      label: 'Resource Templates',
      icon: 'symbol-namespace',
      count: catalog?.resourceTemplates.length ?? 0,
      failed: catalog?.errors?.resourceTemplates,
    },
    prompts: { label: 'Prompts', icon: 'comment-discussion', count: catalog?.prompts.length ?? 0, failed: catalog?.errors?.prompts },
  }[node.group];

  const item = new vscode.TreeItem(
    meta.label,
    meta.count > 0 || meta.failed
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None,
  );
  item.description = meta.failed ? 'failed' : String(meta.count);
  item.iconPath = new vscode.ThemeIcon(meta.icon, meta.failed ? new vscode.ThemeColor('testing.iconFailed') : undefined);
  item.contextValue = `group:${node.group}`;
  item.id = `group:${node.serverId}:${node.group}`;
  return item;
}

function toolItem(node: ToolNode): vscode.TreeItem {
  const { tool } = node;
  const input = describeToolInput(tool.inputSchema);
  const item = new vscode.TreeItem(
    tool.name,
    input.parameters.length || input.problems.length
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None,
  );
  item.description = tool.title ?? firstLine(tool.description) ?? '(no description)';
  item.contextValue = 'tool';
  item.id = `tool:${node.serverId}:${tool.name}`;

  const annotations = tool.annotations ?? {};
  // Same classifier the gate uses, so the icon never disagrees with the
  // confirmation prompt the user is about to get.
  const risk = classifyTool(tool);
  item.iconPath = new vscode.ThemeIcon(
    input.problems.length ? 'warning' : risk === 'destructive' ? 'warning' : risk === 'read' ? 'eye' : 'symbol-method',
    risk === 'destructive' || input.problems.length ? new vscode.ThemeColor('list.warningForeground') : undefined,
  );

  const required = input.parameters.filter((p) => p.required).map((p) => p.name);
  const optional = input.parameters.filter((p) => !p.required).map((p) => p.name);
  const lines = [
    `**${tool.name}**`,
    '',
    tool.description ?? '_No description_',
    '',
    `Required: ${required.length ? required.map((p) => `\`${p}\``).join(', ') : '_none_'}`,
    '',
    `Optional: ${optional.length ? optional.map((p) => `\`${p}\``).join(', ') : '_none_'}`,
  ];
  if (input.problems.length) {
    lines.push('', `⚠️ Schema problems: ${input.problems.join('; ')}`);
  }
  if (annotations.destructiveHint) {
    lines.push('', '⚠️ Annotated as **destructive**');
  }
  if (annotations.readOnlyHint) {
    lines.push('', '👁️ Annotated as **read-only**');
  }
  item.tooltip = markdown(lines.join('\n'));
  return item;
}

function paramNodes(node: ToolNode): ParamNode[] {
  const input = describeToolInput(node.tool.inputSchema);
  const params: ParamNode[] = input.parameters.map((param) => ({
    kind: 'param',
    serverId: node.serverId,
    toolName: node.tool.name,
    label: param.name,
    description: `${param.type}${param.required ? ' · required' : ' · optional'}`,
    tooltip: param.description,
    required: param.required,
    problem: false,
  }));
  const problems: ParamNode[] = input.problems.map((problem, index) => ({
    kind: 'param',
    serverId: node.serverId,
    toolName: `${node.tool.name}#${index}`,
    label: problem,
    required: false,
    problem: true,
  }));
  return [...problems, ...params];
}

function paramItem(node: ParamNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
  item.description = node.description;
  item.id = `param:${node.serverId}:${node.toolName}:${node.label}`;
  item.contextValue = node.problem ? 'param:problem' : 'param';
  item.iconPath = new vscode.ThemeIcon(
    node.problem ? 'warning' : node.required ? 'symbol-field' : 'symbol-property',
    node.problem ? new vscode.ThemeColor('list.warningForeground') : undefined,
  );
  if (node.tooltip) item.tooltip = node.tooltip;
  return item;
}

function infoItem(node: InfoNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
  item.description = node.description;
  item.id = `info:${node.serverId}:${node.key}`;
  item.contextValue = `info:${node.key.split(':')[0]}`;
  item.iconPath = new vscode.ThemeIcon(node.icon, node.color ? new vscode.ThemeColor(node.color) : undefined);
  if (node.tooltip) item.tooltip = node.tooltip;
  if (node.command) item.command = node.command;
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
  item.tooltip = markdown(
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
  item.tooltip = markdown(
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

/**
 * Tool names, descriptions and schemas come from the server and are untrusted.
 * A MarkdownString is untrusted by default - no command links execute and raw
 * HTML is not rendered - and that is set explicitly here so it stays that way.
 */
function markdown(text: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString(text);
  md.isTrusted = false;
  md.supportHtml = false;
  md.supportThemeIcons = false;
  return md;
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

/** Clicking a leaf opens it in the McpLab panel. */
export function attachOpenCommand(item: vscode.TreeItem, node: TreeNode): vscode.TreeItem {
  item.command = {
    command: 'mcplab.openItem',
    title: 'Open in MCP Lab',
    arguments: [node],
  };
  return item;
}
