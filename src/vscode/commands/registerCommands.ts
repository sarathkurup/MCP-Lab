import * as vscode from 'vscode';
import { describeTarget, validateServerConfig, type ServerConfig } from '../../core/config';
import { needsInteractiveSignIn } from '../../core/oauthSession';
import { blockingIssues, describeIssues } from '../../core/projects';
import { explainAuthError } from '../services/OAuthService';
import type { TreeNode } from '../ui/ServersTreeProvider';
import type { McpLab } from '../McpLab';
import {
  analyzeFailure,
  diagnoseServer,
  generateTestsCommand,
  lintServer,
  saveAsTest,
  switchEnvironment,
} from './analysisCommands';
import { openJsonDocument, openMarkdownDocument, resolveServerId } from './helpers';
import { copyBridgeConfig, startBridge, stopBridge } from './bridgeCommands';
import { createServer, generateToolsFromOpenApi } from './scaffoldCommands';
import {
  compareServersCommand,
  generateDocumentation,
  securityScan,
} from './reportCommands';

/** Commands operate on the whole McpLab rather than a hand-picked slice. */
type CommandDeps = McpLab;

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
          void vscode.window.showErrorMessage(`MCP Lab: ${message}`);
          return undefined;
        }
      }),
    );
  };

  register('mcplab.addServer', () => addServer(deps));
  register('mcplab.removeServer', (node?: TreeNode) => removeServer(deps, node));
  register('mcplab.connect', (node?: TreeNode) => connect(deps, node));
  register('mcplab.disconnect', (node?: TreeNode) => disconnect(deps, node));
  register('mcplab.reconnect', (node?: TreeNode) => reconnect(deps, node));
  register('mcplab.refresh', () => deps.reloadServers());
  register('mcplab.showLogs', () => deps.channels.showLogs());
  register('mcplab.showTrace', () => deps.channels.showTrace());
  register('mcplab.open', (node?: TreeNode) => openMcpLab(deps, node));
  register('mcplab.openItem', (node?: TreeNode) => openItem(deps, node));
  register('mcplab.setAuthToken', (node?: TreeNode) => setAuthToken(deps, node));
  register('mcplab.clearAuthToken', (node?: TreeNode) => clearAuthToken(deps, node));
  register('mcplab.signIn', (node?: TreeNode) => signIn(deps, node));
  register('mcplab.signOut', (node?: TreeNode) => signOut(deps, node));
  register('mcplab.reauthenticate', (node?: TreeNode) => reauthenticate(deps, node));
  register('mcplab.selectProject', () => selectProject(deps));
  register('mcplab.refreshTools', (node?: TreeNode) => refreshTools(deps, node));
  register('mcplab.showAuthDiagnostics', (node?: TreeNode) => showAuthDiagnostics(deps, node));
  register('mcplab.storeClientSecret', (node?: TreeNode) => storeClientSecret(deps, node));
  register('mcplab.showAuthLog', () => deps.oauth.showLog());
  register('mcplab.showCapabilities', (node?: TreeNode) => showCapabilities(deps, node));
  register('mcplab.copyDefinition', (node?: TreeNode) => copyDefinition(deps, node));
  register('mcplab.diagnose', (node?: TreeNode) => diagnoseServer(deps, node));
  register('mcplab.lint', (node?: TreeNode) => lintServer(deps, node));
  register('mcplab.generateTests', (...args: never[]) =>
    generateTestsCommand(deps, args[0], args[1]),
  );
  register('mcplab.saveAsTest', (...args: never[]) => saveAsTest(deps, args[0]));
  register('mcplab.analyzeFailure', (...args: never[]) => analyzeFailure(deps, args[0]));
  register('mcplab.switchEnvironment', () => switchEnvironment(deps));
  register('mcplab.runTests', () => deps.focus({ view: 'tests' }));
  register('mcplab.generateDocs', (...args: never[]) =>
    generateDocumentation(deps, args[0]),
  );
  register('mcplab.securityScan', (node?: TreeNode) => securityScan(deps, node));
  register('mcplab.compareServers', () => compareServersCommand(deps));
  register('mcplab.createServer', () => createServer(deps));
  register('mcplab.toolsFromOpenApi', () => generateToolsFromOpenApi());
  register('mcplab.startBridge', () => startBridge(deps));
  register('mcplab.stopBridge', () => stopBridge(deps));
  register('mcplab.copyBridgeConfig', () => copyBridgeConfig(deps));
}

// ---------------------------------------------------------------------------
// OAuth and MCP projects
// ---------------------------------------------------------------------------

/**
 * The server an auth command acts on: the tree node it was invoked from, then
 * the selected project, then the usual single-server or quick-pick choice.
 */
async function resolveProjectTarget(
  deps: CommandDeps,
  node: TreeNode | undefined,
  placeHolder: string,
): Promise<string | undefined> {
  if (node?.serverId) return node.serverId;
  return deps.selectedProjectId() ?? (await resolveServerId(deps, node, placeHolder));
}

/** Approval and configuration checks every OAuth action starts with. */
async function readyForAuth(deps: CommandDeps, serverId: string): Promise<ServerConfig | undefined> {
  let config = deps.store.get(serverId);
  if (!config) throw new Error(`Unknown server "${serverId}"`);
  if (!(await deps.ensureApproved(config))) return undefined;
  config = deps.store.get(serverId) ?? config;

  const blocking = config.project ? blockingIssues(config.project) : [];
  if (blocking.length) {
    const choice = await vscode.window.showErrorMessage(
      `${config.name} is not fully configured: ${describeIssues(blocking)}`,
      'Show Diagnostics',
    );
    if (choice === 'Show Diagnostics') await showAuthDiagnostics(deps, { kind: 'server', serverId });
    return undefined;
  }
  return config;
}

/**
 * Interactive sign-in, then a fresh connection so the new token is used and
 * the tool list is loaded straight away. A hand-added HTTP server is switched
 * to OAuth too, rather than left with a token the transport would ignore.
 */
async function signIn(deps: CommandDeps, node?: TreeNode): Promise<void> {
  const serverId = await resolveProjectTarget(deps, node, 'Sign in to which server?');
  if (!serverId) return;

  let config = await readyForAuth(deps, serverId);
  if (!config) return;
  if (config.transport !== 'http') {
    void vscode.window.showWarningMessage('OAuth applies to HTTP servers; this one is stdio.');
    return;
  }
  if (config.auth?.kind !== 'oauth' && config.source === 'user') {
    config = { ...config, auth: { ...(config.auth ?? {}), kind: 'oauth' } };
    await deps.store.update(config);
    await deps.reloadServers();
  }

  try {
    const session = await deps.oauth.signIn(config);
    void vscode.window.showInformationMessage(`Signed in to ${config.name} as ${session.accountLabel}.`);
  } catch (err) {
    await reportAuthFailure(deps, config, err);
    return;
  }
  await deps.manager.disconnect(serverId);
  await connectServer(deps, serverId);
}

async function signOut(deps: CommandDeps, node?: TreeNode): Promise<void> {
  const serverId = await resolveProjectTarget(deps, node, 'Sign out of which server?');
  if (!serverId) return;

  const config = deps.store.get(serverId);
  // The transport goes first: it must not keep a token the user just revoked.
  await deps.manager.disconnect(serverId);
  const hadSession = config ? await deps.oauth.signOut(config) : false;
  deps.store.invalidateAuth(serverId);
  void vscode.window.showInformationMessage(
    hadSession ? `Signed out of ${config?.name}. Its tokens were removed.` : `${config?.name ?? 'Server'} had no stored sign-in.`,
  );
}

async function reauthenticate(deps: CommandDeps, node?: TreeNode): Promise<void> {
  const serverId = await resolveProjectTarget(deps, node, 'Sign in again to which server?');
  if (!serverId) return;
  const config = await readyForAuth(deps, serverId);
  if (!config) return;
  await deps.manager.disconnect(serverId);
  await deps.oauth.signOut(config);
  await signIn(deps, { kind: 'server', serverId });
}

/** Switching projects disposes the old transport before the new one connects. */
async function selectProject(deps: CommandDeps): Promise<void> {
  const previous = deps.selectedProjectId();
  const projectId = await deps.pickProject('Select the MCP project to work with');
  if (!projectId) return;

  await deps.setSelectedProject(projectId);
  if (previous && previous !== projectId && deps.manager.get(previous)?.status !== 'disconnected') {
    await deps.manager.disconnect(previous);
  }
  await connectServer(deps, projectId);
}

async function refreshTools(deps: CommandDeps, node?: TreeNode): Promise<void> {
  const serverId = await resolveProjectTarget(deps, node, 'Refresh the tools of which server?');
  if (!serverId) return;
  const connection = deps.manager.get(serverId);
  if (!connection) throw new Error(`Unknown server "${serverId}"`);

  if (connection.status !== 'connected') {
    await connectServer(deps, serverId);
    return;
  }
  const catalog = await connection.refreshCatalog();
  if (catalog.errors?.tools) {
    const choice = await vscode.window.showErrorMessage(`${connection.config.name}: ${catalog.errors.tools}`, 'Show Logs');
    if (choice === 'Show Logs') deps.channels.showLogs();
  } else {
    vscode.window.setStatusBarMessage(`MCP: ${connection.config.name} has ${catalog.tools.length} tool(s)`, 5000);
  }
}

async function showAuthDiagnostics(deps: CommandDeps, node?: TreeNode): Promise<void> {
  const serverId = await resolveProjectTarget(deps, node, 'Show authentication diagnostics for which server?');
  if (!serverId) return;
  const config = deps.store.get(serverId);
  if (!config) throw new Error(`Unknown server "${serverId}"`);

  const report = await deps.oauth.diagnostics(config);
  const redirect = report.redirect as { mode?: string; redirectUri?: string } | undefined;
  const lines = [
    `# Authentication diagnostics: ${config.name}`,
    '',
    'Nothing in this report is secret: tokens, codes, verifiers, state values and client secrets are never included.',
    '',
    '## Redirect URI to register with the identity provider',
    '',
    redirect?.redirectUri ? `\`${redirect.redirectUri}\` (callback mode: ${redirect.mode})` : 'Could not be resolved; see below.',
    '',
    '## Report',
    '',
    '```json',
    JSON.stringify(report, null, 2),
    '```',
    '',
  ];
  await openMarkdownDocument(lines.join('\n'));
}

/**
 * For identity providers that insist on a confidential client. A desktop
 * extension should normally be a public client using PKCE alone, so this asks
 * twice before storing anything, and stores it only in the OS keychain.
 */
async function storeClientSecret(deps: CommandDeps, node?: TreeNode): Promise<void> {
  const serverId = await resolveProjectTarget(deps, node, 'Store a client secret for which project?');
  if (!serverId) return;
  const config = deps.store.get(serverId);
  if (!config?.project) {
    throw new Error('Client secrets apply to MCP projects only.');
  }

  const proceed = await vscode.window.showWarningMessage(
    'Store an OAuth client secret for this project?',
    {
      modal: true,
      detail:
        'A desktop extension should normally be a public client using Authorization Code with PKCE and no secret. ' +
        'Only do this if your identity provider cannot register a public client. The secret is kept in the OS ' +
        'keychain (VS Code SecretStorage) and is never written to settings, logs or the UI.',
    },
    'Store Secret',
    'Remove Stored Secret',
  );
  if (!proceed) return;

  if (proceed === 'Remove Stored Secret') {
    await deps.oauth.storeClientSecret(config.project.id, undefined);
    void vscode.window.showInformationMessage(`Removed the stored client secret for ${config.name}.`);
  } else {
    const secret = await vscode.window.showInputBox({
      title: `Client secret for ${config.name}`,
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() ? undefined : 'Enter the secret, or cancel'),
    });
    if (!secret) return;
    await deps.oauth.storeClientSecret(config.project.id, secret.trim());
    void vscode.window.showInformationMessage(`Stored the client secret for ${config.name} in secure storage.`);
  }
  await deps.reloadServers();
}

async function reportAuthFailure(deps: CommandDeps, config: ServerConfig, err: unknown): Promise<void> {
  const choice = await vscode.window.showErrorMessage(
    `${config.name}: ${explainAuthError(err)}`,
    'Show Diagnostics',
    'Show Auth Log',
  );
  if (choice === 'Show Diagnostics') await showAuthDiagnostics(deps, { kind: 'server', serverId: config.id });
  if (choice === 'Show Auth Log') deps.oauth.showLog();
}

// ---------------------------------------------------------------------------
// McpLab panel
// ---------------------------------------------------------------------------

function openMcpLab(deps: CommandDeps, node?: TreeNode): void {
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
        detail: 'MCP Lab spawns the server process and talks over stdin/stdout',
        value: 'stdio' as const,
      },
      {
        label: '$(globe) Remote (streamable HTTP)',
        detail: 'MCP Lab POSTs JSON-RPC to an MCP endpoint',
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
  const serverId = await resolveProjectTarget(deps, node, 'Connect to which server?');
  if (serverId) {
    await connectServer(deps, serverId);
  }
}

/**
 * Connects and loads the catalog. For an OAuth server this is also where a
 * browser sign-in starts - but only here, because the user asked to connect.
 * A background reconnect never opens a browser on its own.
 */
async function connectServer(deps: CommandDeps, serverId: string): Promise<void> {
  const connection = deps.manager.get(serverId);
  if (!connection) {
    throw new Error(`Unknown server "${serverId}"`);
  }
  const oauth = connection.config.auth?.kind === 'oauth';
  if (oauth && !(await readyForAuth(deps, serverId))) {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: `MCP: connecting to ${connection.config.name}…`,
    },
    async () => {
      try {
        try {
          await deps.manager.connect(serverId);
        } catch (err) {
          if (!oauth || !needsInteractiveSignIn(err)) throw err;
          // Not signed in, or the session could not be refreshed: sign in, then
          // connect again with a new transport and the new token.
          const config = deps.store.get(serverId) ?? connection.config;
          await deps.oauth.signIn(config);
          await deps.manager.connect(serverId);
        }
        const catalog = deps.manager.get(serverId)?.catalog;
        if (catalog?.errors?.tools) {
          void vscode.window.showWarningMessage(`${connection.config.name} connected, but ${catalog.errors.tools}`);
        } else if (catalog) {
          vscode.window.setStatusBarMessage(
            `MCP: connected to ${connection.config.name} — ${catalog.tools.length} tool(s)`,
            5000,
          );
        }
      } catch (err) {
        if (oauth) {
          await reportAuthFailure(deps, connection.config, err);
          return;
        }
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
    `Remove "${config.name}" from MCP Lab?`,
    { modal: true, detail: 'The server itself is not touched; only its MCP Lab entry.' },
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
  let payload: unknown;
  if (node?.kind === 'tool') {
    payload = node.tool;
  } else if (node?.kind === 'resource') {
    payload = node.resource;
  } else if (node?.kind === 'prompt') {
    payload = node.prompt;
  } else {
    // From the command palette: pick a tool of the selected (or chosen) server.
    const serverId = await resolveProjectTarget(deps, node, 'Copy a tool definition from which server?');
    const connection = serverId ? deps.manager.get(serverId) : undefined;
    if (!connection) return;
    if (connection.status !== 'connected' || connection.catalog.tools.length === 0) {
      throw new Error(`${connection.config.name} has no tools loaded. Connect first.`);
    }
    const picked = await vscode.window.showQuickPick(
      connection.catalog.tools.map((tool) => ({
        label: tool.name,
        description: tool.description?.split('\n')[0],
        tool,
      })),
      { placeHolder: 'Copy which tool definition?' },
    );
    if (!picked) return;
    payload = picked.tool;
  }

  await vscode.env.clipboard.writeText(JSON.stringify(payload, null, 2));
  void vscode.window.showInformationMessage('MCP: definition copied to clipboard.');
}

