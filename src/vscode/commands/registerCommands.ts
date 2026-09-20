import * as vscode from 'vscode';
import { describeTarget, validateServerConfig, type ServerConfig } from '../../core/config';
import type { TreeNode } from '../ui/ServersTreeProvider';
import type { Workbench } from '../Workbench';

/** Commands operate on the whole Workbench rather than a hand-picked slice. */
type CommandDeps = Workbench;

export function registerCommands(
  context: vscode.ExtensionContext,
  deps: CommandDeps,
): void {
  const register = (id: string, handler: (...args: never[]) => unknown) => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: never[]) => {
        try {
          return await handler(...args);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`MCP Workbench: ${message}`);
          return undefined;
        }
      }),
    );
  };

  register('mcpWorkbench.addServer', () => addServer(deps));
  register('mcpWorkbench.removeServer', (node?: TreeNode) => removeServer(deps, node));
  register('mcpWorkbench.connect', (node?: TreeNode) => connect(deps, node));
  register('mcpWorkbench.disconnect', (node?: TreeNode) => disconnect(deps, node));
  register('mcpWorkbench.reconnect', (node?: TreeNode) => reconnect(deps, node));
  register('mcpWorkbench.refresh', () => deps.reloadServers());
  register('mcpWorkbench.showLogs', () => deps.channels.showLogs());
  register('mcpWorkbench.showTrace', () => deps.channels.showTrace());
  register('mcpWorkbench.open', (node?: TreeNode) => openWorkbench(deps, node));
  register('mcpWorkbench.openItem', (node?: TreeNode) => openItem(deps, node));
  register('mcpWorkbench.setAuthToken', (node?: TreeNode) => setAuthToken(deps, node));
  register('mcpWorkbench.clearAuthToken', (node?: TreeNode) => clearAuthToken(deps, node));
  register('mcpWorkbench.showCapabilities', (node?: TreeNode) => showCapabilities(deps, node));
  register('mcpWorkbench.copyDefinition', (node?: TreeNode) => copyDefinition(deps, node));
}

// ---------------------------------------------------------------------------
// Workbench panel
// ---------------------------------------------------------------------------

function openWorkbench(deps: CommandDeps, node?: TreeNode): void {
  deps.focus({ serverId: node?.serverId, view: 'explorer' });
}

/** Opening a tree item jumps straight to it in the explorer. */
function openItem(deps: CommandDeps, node?: TreeNode): void {
  if (!node) {
    deps.focus({});
    return;
  }
  if (node.kind === 'tool') {
    deps.focus({ serverId: node.serverId, view: 'explorer', selection: { kind: 'tool', name: node.tool.name } });
    return;
  }
  if (node.kind === 'resource') {
    const uri = 'uri' in node.resource ? node.resource.uri : node.resource.uriTemplate;
    deps.focus({ serverId: node.serverId, view: 'explorer', selection: { kind: 'resource', name: uri } });
    return;
  }
  if (node.kind === 'prompt') {
    deps.focus({
      serverId: node.serverId,
      view: 'explorer',
      selection: { kind: 'prompt', name: node.prompt.name },
    });
    return;
  }
  deps.focus({ serverId: node.serverId, view: 'explorer' });
}

// ---------------------------------------------------------------------------
// Add server
// ---------------------------------------------------------------------------

async function addServer(deps: CommandDeps): Promise<void> {
  const transport = await vscode.window.showQuickPick(
    [
      {
        label: '$(terminal) Local (stdio)',
        detail: 'Workbench spawns the server process and talks over stdin/stdout',
        value: 'stdio' as const,
      },
      {
        label: '$(globe) Remote (streamable HTTP)',
        detail: 'Workbench POSTs JSON-RPC to an MCP endpoint',
        value: 'http' as const,
      },
    ],
    { title: 'Add MCP Server (1/3)', placeHolder: 'Transport' },
  );
  if (!transport) {
    return;
  }

  const name = await vscode.window.showInputBox({
    title: 'Add MCP Server (2/3)',
    prompt: 'Display name',
    placeHolder: 'CMS MCP',
    validateInput: (value) => (value.trim() ? undefined : 'Name is required'),
  });
  if (!name) {
    return;
  }

  let draft: Omit<ServerConfig, 'id' | 'source'>;

  if (transport.value === 'stdio') {
    const commandLine = await vscode.window.showInputBox({
      title: 'Add MCP Server (3/3)',
      prompt: 'Command to launch the server',
      placeHolder: 'node dist/server.js',
      validateInput: (value) => (value.trim() ? undefined : 'Command is required'),
    });
    if (!commandLine) {
      return;
    }
    const [command, ...args] = splitCommandLine(commandLine);
    draft = {
      name: name.trim(),
      transport: 'stdio',
      command,
      args,
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    };
  } else {
    const url = await vscode.window.showInputBox({
      title: 'Add MCP Server (3/3)',
      prompt: 'MCP endpoint URL',
      placeHolder: 'https://dev.example.com/mcp',
      validateInput: (value) => {
        const issues = validateServerConfig({ name: 'x', transport: 'http', url: value });
        return issues.find((i) => i.field === 'url')?.message;
      },
    });
    if (!url) {
      return;
    }
    draft = { name: name.trim(), transport: 'http', url: url.trim() };
  }

  const issues = validateServerConfig(draft);
  if (issues.length > 0) {
    throw new Error(issues.map((i) => `${i.field}: ${i.message}`).join('; '));
  }

  const created = await deps.store.add(draft);
  await deps.reloadServers();

  const connectNow = await vscode.window.showInformationMessage(
    `Added "${created.name}" (${describeTarget(created)}).`,
    'Connect',
  );
  if (connectNow === 'Connect') {
    await connectServer(deps, created.id);
  }
}

/** Splits a command line on spaces, honouring simple quoted segments. */
export function splitCommandLine(input: string): string[] {
  const parts: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input)) !== null) {
    parts.push(match[1] ?? match[2] ?? match[3]);
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Lifecycle commands
// ---------------------------------------------------------------------------

async function connect(deps: CommandDeps, node?: TreeNode): Promise<void> {
  const serverId = await resolveServerId(deps, node, 'Connect to which server?');
  if (serverId) {
    await connectServer(deps, serverId);
  }
}

async function connectServer(deps: CommandDeps, serverId: string): Promise<void> {
  const connection = deps.manager.get(serverId);
  if (!connection) {
    throw new Error(`Unknown server "${serverId}"`);
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: `MCP: connecting to ${connection.config.name}…`,
    },
    async () => {
      try {
        await deps.manager.connect(serverId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const action = await vscode.window.showErrorMessage(
          `Could not connect to "${connection.config.name}": ${message}`,
          'Show Logs',
        );
        if (action === 'Show Logs') {
          deps.channels.showLogs();
        }
      }
    },
  );
}

async function disconnect(deps: CommandDeps, node?: TreeNode): Promise<void> {
  const serverId = await resolveServerId(deps, node, 'Disconnect which server?');
  if (serverId) {
    await deps.manager.disconnect(serverId);
  }
}

async function reconnect(deps: CommandDeps, node?: TreeNode): Promise<void> {
  const serverId = await resolveServerId(deps, node, 'Reconnect which server?');
  if (!serverId) {
    return;
  }
  await deps.manager.disconnect(serverId);
  await connectServer(deps, serverId);
}

async function removeServer(deps: CommandDeps, node?: TreeNode): Promise<void> {
  const serverId = await resolveServerId(deps, node, 'Remove which server?');
  if (!serverId) {
    return;
  }
  const config = deps.store.get(serverId);
  if (!config) {
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Remove "${config.name}" from MCP Workbench?`,
    { modal: true, detail: 'The server itself is not touched; only its Workbench entry.' },
    'Remove',
  );
  if (confirm !== 'Remove') {
    return;
  }

  await deps.manager.disconnect(serverId);
  await deps.store.remove(serverId);
  await deps.reloadServers();
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function setAuthToken(deps: CommandDeps, node?: TreeNode): Promise<void> {
  const serverId = await resolveServerId(deps, node, 'Set a token for which server?');
  if (!serverId) {
    return;
  }
  const token = await vscode.window.showInputBox({
    title: 'MCP authentication token',
    prompt: 'Sent as "Authorization: Bearer <token>". Stored in VS Code SecretStorage.',
    password: true,
    ignoreFocusOut: true,
  });
  if (token === undefined) {
    return;
  }
  if (!token.trim()) {
    await deps.store.clearAuthToken(serverId);
    void vscode.window.showInformationMessage('MCP: token cleared.');
    return;
  }
  await deps.store.setAuthToken(serverId, token.trim());
  void vscode.window.showInformationMessage(
    'MCP: token stored. Reconnect for it to take effect.',
  );
}

async function clearAuthToken(deps: CommandDeps, node?: TreeNode): Promise<void> {
  const serverId = await resolveServerId(deps, node, 'Clear the token for which server?');
  if (!serverId) {
    return;
  }
  await deps.store.clearAuthToken(serverId);
  void vscode.window.showInformationMessage('MCP: token cleared.');
}

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

async function showCapabilities(deps: CommandDeps, node?: TreeNode): Promise<void> {
  const serverId = await resolveServerId(deps, node, 'Inspect which server?');
  if (!serverId) {
    return;
  }
  const connection = deps.manager.get(serverId);
  if (!connection || connection.status !== 'connected') {
    throw new Error('Server is not connected.');
  }

  const payload = {
    server: connection.config.name,
    transport: connection.config.transport,
    target: describeTarget(connection.config),
    protocolVersion: connection.protocolVersion,
    serverInfo: connection.serverInfo,
    capabilities: connection.capabilities,
    instructions: connection.instructions,
    catalog: {
      tools: connection.catalog.tools.length,
      resources: connection.catalog.resources.length,
      resourceTemplates: connection.catalog.resourceTemplates.length,
      prompts: connection.catalog.prompts.length,
    },
  };

  await openJsonDocument(payload);
}

async function copyDefinition(deps: CommandDeps, node?: TreeNode): Promise<void> {
  if (!node) {
    return;
  }
  const connection = deps.manager.get(node.serverId);
  if (!connection) {
    return;
  }

  let payload: unknown;
  if (node.kind === 'tool') {
    payload = node.tool;
  } else if (node.kind === 'resource') {
    payload = node.resource;
  } else if (node.kind === 'prompt') {
    payload = node.prompt;
  } else {
    return;
  }

  await vscode.env.clipboard.writeText(JSON.stringify(payload, null, 2));
  void vscode.window.showInformationMessage('MCP: definition copied to clipboard.');
}

async function openJsonDocument(payload: unknown): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({
    content: JSON.stringify(payload, null, 2),
    language: 'json',
  });
  await vscode.window.showTextDocument(doc, { preview: true });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveServerId(
  deps: CommandDeps,
  node: TreeNode | undefined,
  placeHolder: string,
): Promise<string | undefined> {
  if (node?.serverId) {
    return node.serverId;
  }

  const connections = deps.manager.list();
  if (connections.length === 0) {
    throw new Error('No servers configured yet. Run "MCP: Add Server" first.');
  }
  if (connections.length === 1) {
    return connections[0].id;
  }

  const picked = await vscode.window.showQuickPick(
    connections.map((c) => ({
      label: c.config.name,
      description: c.status,
      detail: describeTarget(c.config),
      value: c.id,
    })),
    { placeHolder },
  );
  return picked?.value;
}
