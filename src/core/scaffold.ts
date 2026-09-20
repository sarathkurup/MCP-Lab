/**
 * Project scaffolding for a new MCP server.
 *
 * Returns a plain map of relative path -> contents so the same generator can
 * write to disk from the extension, from the CLI, or be snapshot-tested.
 */

export type ScaffoldLanguage = 'typescript' | 'python' | 'csharp';
export type ScaffoldTransport = 'stdio' | 'http';

export interface ScaffoldOptions {
  name: string;
  language: ScaffoldLanguage;
  transport: ScaffoldTransport;
  features: {
    tools: boolean;
    resources: boolean;
    prompts: boolean;
  };
  description?: string;
}

export type ScaffoldFiles = Record<string, string>;

export function scaffold(options: ScaffoldOptions): ScaffoldFiles {
  switch (options.language) {
    case 'typescript':
      return typescriptProject(options);
    case 'python':
      return pythonProject(options);
    case 'csharp':
      return csharpProject(options);
  }
}

// ---------------------------------------------------------------------------
// TypeScript
// ---------------------------------------------------------------------------

function typescriptProject(options: ScaffoldOptions): ScaffoldFiles {
  const pkgName = slug(options.name);
  const files: ScaffoldFiles = {};

  files['package.json'] = JSON.stringify(
    {
      name: pkgName,
      version: '0.1.0',
      description: options.description ?? `${options.name} MCP server`,
      type: 'module',
      bin: { [pkgName]: './dist/server.js' },
      scripts: {
        build: 'tsc',
        watch: 'tsc --watch',
        start: 'node dist/server.js',
      },
      dependencies: {
        '@modelcontextprotocol/sdk': '^1.0.0',
        zod: '^3.23.0',
      },
      devDependencies: {
        '@types/node': '^20.14.0',
        typescript: '^5.5.0',
      },
    },
    null,
    2,
  );

  files['tsconfig.json'] = JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'Node16',
        moduleResolution: 'Node16',
        outDir: 'dist',
        rootDir: 'src',
        strict: true,
        skipLibCheck: true,
        declaration: false,
        sourceMap: true,
      },
      include: ['src/**/*.ts'],
    },
    null,
    2,
  );

  const registrations: string[] = [];
  if (options.features.tools) {
    registrations.push('registerTools(server);');
  }
  if (options.features.resources) {
    registrations.push('registerResources(server);');
  }
  if (options.features.prompts) {
    registrations.push('registerPrompts(server);');
  }

  const imports: string[] = [];
  if (options.features.tools) {
    imports.push("import { registerTools } from './tools/index.js';");
  }
  if (options.features.resources) {
    imports.push("import { registerResources } from './resources/index.js';");
  }
  if (options.features.prompts) {
    imports.push("import { registerPrompts } from './prompts/index.js';");
  }

  files['src/server.ts'] = [
    `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
    options.transport === 'stdio'
      ? `import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';`
      : `import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';\nimport { createServer } from 'node:http';`,
    ...imports,
    '',
    `const server = new McpServer({`,
    `  name: '${pkgName}',`,
    `  version: '0.1.0',`,
    `});`,
    '',
    ...registrations,
    '',
    options.transport === 'stdio'
      ? stdioBootstrap()
      : httpBootstrap(),
    '',
  ].join('\n');

  if (options.features.tools) {
    files['src/tools/index.ts'] = [
      `import { z } from 'zod';`,
      `import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
      '',
      `export function registerTools(server: McpServer): void {`,
      `  server.registerTool(`,
      `    'getItem',`,
      `    {`,
      `      // A description is what a client uses to decide when to call this.`,
      `      description: 'Fetches a single item by id.',`,
      `      inputSchema: {`,
      `        id: z.string().describe('Identifier of the item to fetch'),`,
      `      },`,
      `      annotations: { readOnlyHint: true },`,
      `    },`,
      `    async ({ id }) => {`,
      `      // TODO: call your real backend here.`,
      `      return {`,
      `        content: [{ type: 'text', text: \`Item \${id}\` }],`,
      `        structuredContent: { id, name: 'Example' },`,
      `      };`,
      `    },`,
      `  );`,
      '',
      `  server.registerTool(`,
      `    'deleteItem',`,
      `    {`,
      `      description: 'Deletes an item permanently.',`,
      `      inputSchema: { id: z.string().describe('Identifier of the item to delete') },`,
      `      // Clients ask a human before running a destructive tool.`,
      `      annotations: { destructiveHint: true, idempotentHint: true },`,
      `    },`,
      `    async ({ id }) => ({`,
      `      content: [{ type: 'text', text: \`Deleted \${id}\` }],`,
      `    }),`,
      `  );`,
      `}`,
      '',
    ].join('\n');
  }

  if (options.features.resources) {
    files['src/resources/index.ts'] = [
      `import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
      '',
      `export function registerResources(server: McpServer): void {`,
      `  server.registerResource(`,
      `    'config',`,
      `    'config://app',`,
      `    {`,
      `      description: 'Current application configuration.',`,
      `      mimeType: 'application/json',`,
      `    },`,
      `    async (uri) => ({`,
      `      contents: [`,
      `        {`,
      `          uri: uri.href,`,
      `          mimeType: 'application/json',`,
      `          text: JSON.stringify({ environment: process.env.NODE_ENV ?? 'dev' }, null, 2),`,
      `        },`,
      `      ],`,
      `    }),`,
      `  );`,
      `}`,
      '',
    ].join('\n');
  }

  if (options.features.prompts) {
    files['src/prompts/index.ts'] = [
      `import { z } from 'zod';`,
      `import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
      '',
      `export function registerPrompts(server: McpServer): void {`,
      `  server.registerPrompt(`,
      `    'summarize',`,
      `    {`,
      `      description: 'Summarizes an item for a reader in a hurry.',`,
      `      argsSchema: { id: z.string().describe('Item identifier') },`,
      `    },`,
      `    ({ id }) => ({`,
      `      messages: [`,
      `        {`,
      `          role: 'user',`,
      `          content: { type: 'text', text: \`Summarize item \${id} in three bullet points.\` },`,
      `        },`,
      `      ],`,
      `    }),`,
      `  );`,
      `}`,
      '',
    ].join('\n');
  }

  files['mcp.config.json'] = workbenchConfig(options, {
    command: 'node',
    args: ['dist/server.js'],
  });
  files['.gitignore'] = 'node_modules/\ndist/\n';
  files['README.md'] = readme(options, [
    '```bash',
    'npm install',
    'npm run build',
    options.transport === 'stdio' ? 'npm start' : 'PORT=3000 npm start',
    '```',
  ]);

  return files;
}

function stdioBootstrap(): string {
  return [
    `const transport = new StdioServerTransport();`,
    `await server.connect(transport);`,
    '',
    `// stdout carries protocol only: anything else corrupts the stream.`,
    `console.error('MCP server ready on stdio');`,
  ].join('\n');
}

function httpBootstrap(): string {
  return [
    `const transport = new StreamableHTTPServerTransport({`,
    `  sessionIdGenerator: () => crypto.randomUUID(),`,
    `});`,
    `await server.connect(transport);`,
    '',
    `const port = Number(process.env.PORT ?? 3000);`,
    `createServer((req, res) => {`,
    `  if (!req.url?.startsWith('/mcp')) {`,
    `    res.writeHead(404).end();`,
    `    return;`,
    `  }`,
    `  void transport.handleRequest(req, res);`,
    `}).listen(port, () => console.error(\`MCP server ready on http://localhost:\${port}/mcp\`));`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

function pythonProject(options: ScaffoldOptions): ScaffoldFiles {
  const pkgName = slug(options.name).replace(/-/g, '_');
  const files: ScaffoldFiles = {};

  files['pyproject.toml'] = [
    '[project]',
    `name = "${slug(options.name)}"`,
    'version = "0.1.0"',
    `description = "${options.description ?? options.name + ' MCP server'}"`,
    'requires-python = ">=3.10"',
    'dependencies = ["mcp>=1.2.0"]',
    '',
    '[project.scripts]',
    `${slug(options.name)} = "${pkgName}.server:main"`,
    '',
    '[build-system]',
    'requires = ["hatchling"]',
    'build-backend = "hatchling.build"',
    '',
  ].join('\n');

  const body: string[] = [
    'from mcp.server.fastmcp import FastMCP',
    '',
    `mcp = FastMCP("${slug(options.name)}")`,
    '',
  ];

  if (options.features.tools) {
    body.push(
      '',
      '@mcp.tool()',
      'def get_item(item_id: str) -> dict:',
      '    """Fetch a single item by id."""',
      '    # TODO: call your real backend here.',
      '    return {"id": item_id, "name": "Example"}',
      '',
      '',
      '@mcp.tool(annotations={"destructiveHint": True, "idempotentHint": True})',
      'def delete_item(item_id: str) -> str:',
      '    """Delete an item permanently."""',
      '    return f"Deleted {item_id}"',
      '',
    );
  }

  if (options.features.resources) {
    body.push(
      '',
      '@mcp.resource("config://app")',
      'def config() -> str:',
      '    """Current application configuration."""',
      '    return \'{"environment": "dev"}\'',
      '',
    );
  }

  if (options.features.prompts) {
    body.push(
      '',
      '@mcp.prompt()',
      'def summarize(item_id: str) -> str:',
      '    """Summarize an item for a reader in a hurry."""',
      '    return f"Summarize item {item_id} in three bullet points."',
      '',
    );
  }

  body.push(
    '',
    'def main() -> None:',
    options.transport === 'stdio'
      ? '    mcp.run(transport="stdio")'
      : '    mcp.run(transport="streamable-http")',
    '',
    '',
    'if __name__ == "__main__":',
    '    main()',
    '',
  );

  files[`src/${pkgName}/__init__.py`] = '';
  files[`src/${pkgName}/server.py`] = body.join('\n');
  files['mcp.config.json'] = workbenchConfig(options, {
    command: 'python',
    args: ['-m', `${pkgName}.server`],
  });
  files['.gitignore'] = '__pycache__/\n.venv/\ndist/\n*.egg-info/\n';
  files['README.md'] = readme(options, [
    '```bash',
    'python -m venv .venv && . .venv/bin/activate',
    'pip install -e .',
    `python -m ${pkgName}.server`,
    '```',
  ]);

  return files;
}

// ---------------------------------------------------------------------------
// C#
// ---------------------------------------------------------------------------

function csharpProject(options: ScaffoldOptions): ScaffoldFiles {
  const projectName = pascal(options.name);
  const files: ScaffoldFiles = {};

  files[`${projectName}.csproj`] = [
    '<Project Sdk="Microsoft.NET.Sdk">',
    '',
    '  <PropertyGroup>',
    '    <OutputType>Exe</OutputType>',
    '    <TargetFramework>net8.0</TargetFramework>',
    '    <Nullable>enable</Nullable>',
    '    <ImplicitUsings>enable</ImplicitUsings>',
    '  </PropertyGroup>',
    '',
    '  <ItemGroup>',
    '    <PackageReference Include="ModelContextProtocol" Version="0.3.0-preview.1" />',
    '    <PackageReference Include="Microsoft.Extensions.Hosting" Version="8.0.0" />',
    '  </ItemGroup>',
    '',
    '</Project>',
    '',
  ].join('\n');

  files['Program.cs'] = [
    'using Microsoft.Extensions.DependencyInjection;',
    'using Microsoft.Extensions.Hosting;',
    'using Microsoft.Extensions.Logging;',
    '',
    'var builder = Host.CreateApplicationBuilder(args);',
    '',
    '// stdout carries MCP protocol only, so logs must go to stderr.',
    'builder.Logging.AddConsole(options => options.LogToStandardErrorThreshold = LogLevel.Trace);',
    '',
    'builder.Services',
    '    .AddMcpServer()',
    options.transport === 'stdio' ? '    .WithStdioServerTransport()' : '    .WithHttpTransport()',
    options.features.tools ? '    .WithToolsFromAssembly()' : '',
    options.features.prompts ? '    .WithPromptsFromAssembly()' : '',
    '    ;',
    '',
    'await builder.Build().RunAsync();',
    '',
  ]
    .filter((line) => line !== '')
    .join('\n');

  if (options.features.tools) {
    files['Tools/ItemTools.cs'] = [
      'using System.ComponentModel;',
      'using ModelContextProtocol.Server;',
      '',
      `namespace ${projectName}.Tools;`,
      '',
      '[McpServerToolType]',
      'public static class ItemTools',
      '{',
      '    [McpServerTool(Name = "getItem", ReadOnly = true)]',
      '    [Description("Fetches a single item by id.")]',
      '    public static object GetItem(',
      '        [Description("Identifier of the item to fetch")] string id)',
      '    {',
      '        // TODO: call your real backend here.',
      '        return new { id, name = "Example" };',
      '    }',
      '',
      '    [McpServerTool(Name = "deleteItem", Destructive = true, Idempotent = true)]',
      '    [Description("Deletes an item permanently.")]',
      '    public static string DeleteItem(',
      '        [Description("Identifier of the item to delete")] string id)',
      '        => $"Deleted {id}";',
      '}',
      '',
    ].join('\n');
  }

  if (options.features.prompts) {
    files['Prompts/SummaryPrompts.cs'] = [
      'using System.ComponentModel;',
      'using ModelContextProtocol.Server;',
      '',
      `namespace ${projectName}.Prompts;`,
      '',
      '[McpServerPromptType]',
      'public static class SummaryPrompts',
      '{',
      '    [McpServerPrompt(Name = "summarize")]',
      '    [Description("Summarizes an item for a reader in a hurry.")]',
      '    public static string Summarize(',
      '        [Description("Item identifier")] string id)',
      '        => $"Summarize item {id} in three bullet points.";',
      '}',
      '',
    ].join('\n');
  }

  files['mcp.config.json'] = workbenchConfig(options, {
    command: 'dotnet',
    args: ['run', '--project', `${projectName}.csproj`],
  });
  files['.gitignore'] = 'bin/\nobj/\n';
  files['README.md'] = readme(options, [
    '```bash',
    'dotnet restore',
    `dotnet run --project ${projectName}.csproj`,
    '```',
  ]);

  return files;
}

// ---------------------------------------------------------------------------

function workbenchConfig(
  options: ScaffoldOptions,
  stdio: { command: string; args: string[] },
): string {
  return JSON.stringify(
    {
      servers: [
        options.transport === 'stdio'
          ? {
              id: slug(options.name),
              name: options.name,
              transport: 'stdio',
              command: stdio.command,
              args: stdio.args,
            }
          : {
              id: slug(options.name),
              name: options.name,
              transport: 'http',
              url: 'http://localhost:3000/mcp',
            },
      ],
    },
    null,
    2,
  );
}

function readme(options: ScaffoldOptions, run: string[]): string {
  const features = Object.entries(options.features)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);

  return [
    `# ${options.name}`,
    '',
    options.description ?? 'An MCP server.',
    '',
    `- Language: ${options.language}`,
    `- Transport: ${options.transport}`,
    `- Features: ${features.join(', ') || 'none'}`,
    '',
    '## Running',
    '',
    ...run,
    '',
    '## Working on it',
    '',
    'This project ships an `mcp.config.json`, so MCP Workbench and the',
    '`mcp-workbench` CLI can both reach it:',
    '',
    '```bash',
    'mcp-workbench doctor --config mcp.config.json',
    'mcp-workbench lint   --config mcp.config.json',
    'mcp-workbench test   --config mcp.config.json',
    '```',
    '',
    '## Conventions worth keeping',
    '',
    '- Every tool needs a description: clients use it to decide when to call.',
    '- Annotate destructive tools with `destructiveHint` so clients ask a human.',
    '- On stdio, stdout is protocol only. Log to stderr.',
    '- Declare an output schema where the result has a stable shape.',
    '',
  ].join('\n');
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'mcp-server'
  );
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
