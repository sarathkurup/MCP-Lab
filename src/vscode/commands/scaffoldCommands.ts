import * as vscode from 'vscode';
import {
  generateTypeScriptHandlers,
  toolsFromOpenApi,
  type GeneratedTool,
  type OpenApiDocument,
} from '../../core/openapi';
import { scaffold, type ScaffoldLanguage, type ScaffoldOptions, type ScaffoldTransport } from '../../core/scaffold';
import type { Workbench } from '../Workbench';
import { openMarkdownDocument } from './helpers';

/** Creating a new MCP server, and turning an existing REST API into one. */

export async function createServer(workbench: Workbench): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: 'Create MCP Server (1/4)',
    prompt: 'Server name',
    placeHolder: 'Deployment MCP',
    validateInput: (value) => (value.trim() ? undefined : 'Name is required'),
  });
  if (!name) {
    return;
  }

  const language = await vscode.window.showQuickPick(
    [
      { label: 'TypeScript', detail: '@modelcontextprotocol/sdk + zod', value: 'typescript' as const },
      { label: 'Python', detail: 'mcp FastMCP', value: 'python' as const },
      { label: 'C#', detail: 'ModelContextProtocol + Microsoft.Extensions.Hosting', value: 'csharp' as const },
    ],
    { title: 'Create MCP Server (2/4)', placeHolder: 'Language' },
  );
  if (!language) {
    return;
  }

  const transport = await vscode.window.showQuickPick(
    [
      { label: 'stdio', detail: 'Launched as a child process by the client', value: 'stdio' as const },
      { label: 'Streamable HTTP', detail: 'Hosted at a URL', value: 'http' as const },
    ],
    { title: 'Create MCP Server (3/4)', placeHolder: 'Transport' },
  );
  if (!transport) {
    return;
  }

  const features = await vscode.window.showQuickPick(
    [
      { label: 'Tools', value: 'tools' as const, picked: true },
      { label: 'Resources', value: 'resources' as const, picked: true },
      { label: 'Prompts', value: 'prompts' as const, picked: true },
    ],
    { title: 'Create MCP Server (4/4)', placeHolder: 'Features', canPickMany: true },
  );
  if (!features) {
    return;
  }

  const options: ScaffoldOptions = {
    name: name.trim(),
    language: language.value as ScaffoldLanguage,
    transport: transport.value as ScaffoldTransport,
    features: {
      tools: features.some((f) => f.value === 'tools'),
      resources: features.some((f) => f.value === 'resources'),
      prompts: features.some((f) => f.value === 'prompts'),
    },
  };

  const target = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: 'Create here',
    defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
  });
  if (!target || target.length === 0) {
    return;
  }

  const root = vscode.Uri.joinPath(target[0], slug(options.name));
  const files = scaffold(options);

  // Never clobber an existing project.
  try {
    await vscode.workspace.fs.stat(root);
    const overwrite = await vscode.window.showWarningMessage(
      `${root.fsPath} already exists.`,
      { modal: true, detail: 'Files with the same names will be overwritten.' },
      'Write anyway',
    );
    if (overwrite !== 'Write anyway') {
      return;
    }
  } catch {
    // Does not exist, which is the happy path.
  }

  for (const [relativePath, contents] of Object.entries(files)) {
    const uri = vscode.Uri.joinPath(root, ...relativePath.split('/'));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(contents, 'utf8'));
  }

  const action = await vscode.window.showInformationMessage(
    `Created ${Object.keys(files).length} file(s) in ${root.fsPath}`,
    'Open folder',
    'Add to MCPilot',
  );

  if (action === 'Open folder') {
    await vscode.commands.executeCommand('vscode.openFolder', root, { forceNewWindow: true });
    return;
  }

  if (action === 'Add to MCPilot') {
    const created = await workbench.store.add(
      options.transport === 'stdio'
        ? {
            name: options.name,
            transport: 'stdio',
            command: commandFor(options.language),
            args: argsFor(options.language, options.name),
            cwd: root.fsPath,
          }
        : { name: options.name, transport: 'http', url: 'http://localhost:3000/mcp' },
    );
    await workbench.reloadServers();
    void vscode.window.showInformationMessage(
      `Added "${created.name}". Build it first, then connect.`,
    );
  }
}

function commandFor(language: ScaffoldLanguage): string {
  return language === 'csharp' ? 'dotnet' : language === 'python' ? 'python' : 'node';
}

function argsFor(language: ScaffoldLanguage, name: string): string[] {
  if (language === 'csharp') {
    return ['run', '--project', `${pascal(name)}.csproj`];
  }
  if (language === 'python') {
    return ['-m', `${slug(name).replace(/-/g, '_')}.server`];
  }
  return ['dist/server.js'];
}

// ---------------------------------------------------------------------------
// REST -> MCP
// ---------------------------------------------------------------------------

export async function generateToolsFromOpenApi(): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: 'Use this OpenAPI document',
    filters: { 'OpenAPI / Swagger': ['json'] },
  });
  if (!picked || picked.length === 0) {
    return;
  }

  let document: OpenApiDocument;
  try {
    document = JSON.parse(
      Buffer.from(await vscode.workspace.fs.readFile(picked[0])).toString('utf8'),
    ) as OpenApiDocument;
  } catch (err) {
    throw new Error(`Could not parse that document: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!document.paths || Object.keys(document.paths).length === 0) {
    throw new Error('That document declares no paths.');
  }

  const tags = [
    ...new Set(
      Object.values(document.paths)
        .flatMap((operations) => Object.values(operations))
        .flatMap((operation) => operation.tags ?? []),
    ),
  ].sort();

  let tagFilter: string | undefined;
  if (tags.length > 1) {
    const chosen = await vscode.window.showQuickPick(
      [{ label: 'All operations', value: undefined as string | undefined }, ...tags.map((tag) => ({ label: tag, value: tag }))],
      { placeHolder: 'Which operations?' },
    );
    if (!chosen) {
      return;
    }
    tagFilter = chosen.value;
  }

  const generated = toolsFromOpenApi(document, { tagFilter });
  if (generated.length === 0) {
    throw new Error('No operations matched.');
  }

  const selected = await vscode.window.showQuickPick(
    generated.map((entry) => ({
      label: entry.tool.name,
      description: `${entry.binding.method} ${entry.binding.path}`,
      detail: entry.warnings.length ? `⚠️ ${entry.warnings.join(' ')}` : entry.tool.description,
      value: entry,
      picked: true,
    })),
    {
      canPickMany: true,
      title: `${generated.length} operation(s) from ${document.info?.title ?? 'the document'}`,
      placeHolder: 'Choose the operations to expose as MCP tools',
    },
  );
  if (!selected || selected.length === 0) {
    return;
  }

  const chosen = selected.map((entry) => entry.value);
  const baseUrl = document.servers?.[0]?.url ?? 'https://api.example.com';

  const handlers = generateTypeScriptHandlers(chosen, baseUrl);
  const doc = await vscode.workspace.openTextDocument({
    content: handlers,
    language: 'typescript',
  });
  await vscode.window.showTextDocument(doc, { preview: false });

  const warnings = chosen.flatMap((entry) =>
    entry.warnings.map((warning) => `- \`${entry.tool.name}\`: ${warning}`),
  );
  if (warnings.length > 0) {
    await openMarkdownDocument(
      [
        '# REST → MCP conversion notes',
        '',
        `Generated ${chosen.length} tool(s) from ${document.info?.title ?? 'an OpenAPI document'}.`,
        '',
        '## Things worth checking',
        '',
        ...warnings,
        '',
        '## Before shipping',
        '',
        '- Add authentication to the generated `fetch` calls.',
        '- Review the annotations: methods were mapped to hints by verb, which is a',
        '  starting point, not a judgement about what the endpoint really does.',
        '- Tighten descriptions. A model picks tools by description.',
        '',
      ].join('\n'),
    );
  }
}

/** Summary used by the quick pick and by tests. */
export function describeGenerated(entry: GeneratedTool): string {
  const count = Object.keys(entry.tool.inputSchema.properties ?? {}).length;
  return `${entry.binding.method} ${entry.binding.path} → ${entry.tool.name} (${count} parameter(s))`;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'mcp-server';
}

function pascal(name: string): string {
  return (
    name
      .replace(/[^A-Za-z0-9]+/g, ' ')
      .trim()
      .split(/\s+/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('') || 'McpServer'
  );
}
