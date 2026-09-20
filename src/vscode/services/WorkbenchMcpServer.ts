import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { diagnose } from '../../core/doctor';
import { classifyTool } from '../../core/environments';
import { lint } from '../../core/linter';
import type { JsonRpcMessage } from '../../core/protocol';
import { jsonResult, McpServerRole, textResult } from '../../core/serverRole';
import { TestRunner } from '../../core/testing';
import { generateTests } from '../../core/testgen';
import type { Workbench } from '../Workbench';

const TOKEN_KEY = 'mcplab.bridgeToken';

/**
 * Workbench exposed as an MCP server.
 *
 *   Claude Code / Copilot ──MCP──▶ MCP Lab ──MCP──▶ CMS, Deployment, AWS…
 *
 * The point is not convenience, it is control: an AI client gets one endpoint,
 * and every call through it passes the same guards a human's click would -
 * tool classification, environment tier, and an approval prompt for anything
 * that writes. Bound to loopback and gated by a bearer token.
 */
export class WorkbenchMcpServer implements vscode.Disposable {
  private readonly role: McpServerRole;
  private http?: Server;
  private port?: number;
  private token?: string;
  /** Tools the user approved for this session, so one yes is not asked twice. */
  private readonly sessionApprovals = new Set<string>();

  constructor(private readonly workbench: Workbench) {
    this.role = new McpServerRole({
      name: 'mcplab',
      version: '0.1.0',
      instructions: [
        'MCP Lab aggregates the MCP servers a developer has configured.',
        'Use listMcpServers to see what exists, inspectMcpTool before calling anything,',
        'and executeMcpTool to invoke a tool on one of those servers.',
        'Write and destructive operations require a human to approve them, so a refusal',
        'is a normal outcome rather than an error to work around.',
      ].join(' '),
      authorize: (name, args) => this.authorize(name, args),
      onLog: (message) => this.workbench.logs.log('warn', message, { source: 'workbench' }),
    });

    this.registerTools();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  get isRunning(): boolean {
    return !!this.http;
  }

  get endpoint(): string | undefined {
    return this.port ? `http://127.0.0.1:${this.port}/mcp` : undefined;
  }

  async start(): Promise<{ url: string; token: string }> {
    if (this.http && this.port && this.token) {
      return { url: this.endpoint!, token: this.token };
    }

    this.token =
      (await this.workbench.context.secrets.get(TOKEN_KEY)) ?? randomBytes(24).toString('hex');
    await this.workbench.context.secrets.store(TOKEN_KEY, this.token);

    const server = createServer((req, res) => void this.handleRequest(req, res));

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // Loopback only: this endpoint can reach every configured MCP server.
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server.address();
    this.port = typeof address === 'object' && address ? address.port : undefined;
    this.http = server;

    this.workbench.logs.log('info', `MCP Lab MCP server listening on ${this.endpoint}`);
    return { url: this.endpoint!, token: this.token };
  }

  async stop(): Promise<void> {
    const server = this.http;
    this.http = undefined;
    this.port = undefined;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
    this.workbench.logs.log('info', 'MCP Lab MCP server stopped');
  }

  private async handleRequest(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ): Promise<void> {
    if (req.headers.authorization !== `Bearer ${this.token}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      // No server-initiated stream; sessions are stateless here.
      res.writeHead(req.method === 'GET' ? 405 : 204).end();
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 4_000_000) {
        req.destroy();
      }
    });

    req.on('end', () => {
      void (async () => {
        let message: JsonRpcMessage;
        try {
          message = JSON.parse(body) as JsonRpcMessage;
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
          return;
        }

        const response = await this.role.handle(message);
        if (!response) {
          res.writeHead(202).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(response));
      })();
    });
  }

  // -------------------------------------------------------------------------
  // Authorization
  // -------------------------------------------------------------------------

  private async authorize(name: string, args: Record<string, unknown>): Promise<boolean> {
    const policy = vscode.workspace
      .getConfiguration('mcplab')
      .get<{ readTools: boolean; writeTools: boolean; destructiveTools: boolean; production: boolean }>(
        'ai.permissions',
        { readTools: true, writeTools: false, destructiveTools: false, production: false },
      );

    // Everything except executeMcpTool is read-only inspection of Workbench itself.
    if (name !== 'executeMcpTool') {
      return true;
    }

    const serverName = String(args.server ?? '');
    const toolName = String(args.tool ?? '');
    const serverId = this.workbench.resolveServerByName(serverName);
    const connection = serverId ? this.workbench.manager.get(serverId) : undefined;
    const definition = connection?.catalog.tools.find((t) => t.name === toolName);
    const risk = definition ? classifyTool(definition) : 'write';
    const tier = this.workbench.activeEnvironment?.tier;

    if (risk === 'read' && policy.readTools && !(tier === 'prod' && !policy.production)) {
      return true;
    }

    const approvalKey = `${serverName}:${toolName}:${tier ?? 'none'}`;
    if (this.sessionApprovals.has(approvalKey)) {
      return true;
    }

    const allowedByPolicy =
      (risk === 'write' && policy.writeTools) ||
      (risk === 'destructive' && policy.destructiveTools);
    const productionBlocked = tier === 'prod' && !policy.production;

    if (allowedByPolicy && !productionBlocked) {
      return true;
    }

    // Ask a human. The prompt names the AI client's request precisely.
    const choice = await vscode.window.showWarningMessage(
      `An AI client wants to run "${toolName}" on ${serverName || 'an unknown server'}.`,
      {
        modal: true,
        detail: [
          `Classification: ${risk}`,
          `Environment: ${this.workbench.activeEnvironment?.name ?? 'none'}`,
          '',
          'Arguments:',
          JSON.stringify(args.arguments ?? {}, null, 2).slice(0, 800),
        ].join('\n'),
      },
      'Allow once',
      'Allow for this session',
    );

    if (choice === 'Allow for this session') {
      this.sessionApprovals.add(approvalKey);
      return true;
    }
    return choice === 'Allow once';
  }

  clearSessionApprovals(): void {
    this.sessionApprovals.clear();
  }

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  private registerTools(): void {
    this.role.register({
      tool: {
        name: 'listMcpServers',
        description:
          'Lists the MCP servers configured in MCP Lab, with their status, health and what they expose.',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
      },
      handler: () => jsonResult(this.workbench.catalog()),
    });

    this.role.register({
      tool: {
        name: 'searchMcp',
        description:
          'Searches every connected MCP server for tools, resources and prompts matching a query. Use this to find a capability by what it does.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What you are looking for, e.g. "deployment status"' },
          },
          required: ['query'],
        },
        annotations: { readOnlyHint: true },
      },
      handler: (args) => jsonResult(this.workbench.search(String(args.query ?? ''))),
    });

    this.role.register({
      tool: {
        name: 'listMcpTools',
        description: 'Lists the tools exposed by one configured MCP server.',
        inputSchema: {
          type: 'object',
          properties: { server: { type: 'string', description: 'Server name' } },
          required: ['server'],
        },
        annotations: { readOnlyHint: true },
      },
      handler: (args) => {
        const connection = this.requireConnection(String(args.server));
        return jsonResult(
          connection.catalog.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            risk: classifyTool(tool),
            required: tool.inputSchema?.required ?? [],
          })),
        );
      },
    });

    this.role.register({
      tool: {
        name: 'inspectMcpTool',
        description:
          'Returns the full definition of one tool, including its input schema. Call this before executeMcpTool.',
        inputSchema: {
          type: 'object',
          properties: {
            server: { type: 'string', description: 'Server name' },
            tool: { type: 'string', description: 'Tool name' },
          },
          required: ['server', 'tool'],
        },
        annotations: { readOnlyHint: true },
      },
      handler: (args) => {
        const connection = this.requireConnection(String(args.server));
        const tool = connection.catalog.tools.find((t) => t.name === String(args.tool));
        if (!tool) {
          throw new Error(`"${connection.config.name}" has no tool "${String(args.tool)}"`);
        }
        return jsonResult({ ...tool, risk: classifyTool(tool) });
      },
    });

    this.role.register({
      tool: {
        name: 'executeMcpTool',
        description:
          'Invokes a tool on one of the configured MCP servers. Write and destructive operations require a human to approve them.',
        inputSchema: {
          type: 'object',
          properties: {
            server: { type: 'string', description: 'Server name' },
            tool: { type: 'string', description: 'Tool name' },
            arguments: { type: 'object', description: 'Arguments matching the tool input schema' },
          },
          required: ['server', 'tool'],
        },
      },
      handler: async (args) => {
        const connection = this.requireConnection(String(args.server));
        const result = await this.workbench.execution.callTool(
          connection.id,
          String(args.tool),
          args.arguments ?? {},
          { environment: this.workbench.activeEnvironment?.name },
        );
        if (result.error) {
          return {
            isError: true,
            content: [{ type: 'text', text: result.error.message }],
          };
        }
        return (result.result ?? jsonResult(null)) as ReturnType<typeof jsonResult>;
      },
    });

    this.role.register({
      tool: {
        name: 'getMcpLogs',
        description: 'Returns recent MCP Lab and server log lines, useful when a call failed.',
        inputSchema: {
          type: 'object',
          properties: {
            server: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
          },
        },
        annotations: { readOnlyHint: true },
      },
      handler: (args) => {
        const serverId = args.server ? this.workbench.resolveServerByName(String(args.server)) : undefined;
        const limit = Number(args.limit ?? 100);
        const lines = this.workbench.logs
          .query({ serverId })
          .slice(-limit)
          .map((entry) => `${new Date(entry.timestamp).toISOString()} ${entry.level} ${entry.message}`);
        return textResult(lines.join('\n') || 'No log lines.');
      },
    });

    this.role.register({
      tool: {
        name: 'diagnoseMcpServer',
        description: 'Runs MCP Lab diagnostics against a server: connectivity, protocol, schema quality, security, coverage.',
        inputSchema: {
          type: 'object',
          properties: { server: { type: 'string' } },
          required: ['server'],
        },
        annotations: { readOnlyHint: true },
      },
      handler: async (args) => {
        const connection = this.requireConnection(String(args.server));
        const report = await diagnose(connection, {
          probe: true,
          testedTargets: this.workbench.tests.list().length
            ? this.workbench.tests.testedTargets()
            : undefined,
        });
        return jsonResult(report);
      },
    });

    this.role.register({
      tool: {
        name: 'lintMcpServer',
        description: 'Static analysis of a server’s advertised catalog (MCP001-MCP012).',
        inputSchema: {
          type: 'object',
          properties: { server: { type: 'string' } },
          required: ['server'],
        },
        annotations: { readOnlyHint: true },
      },
      handler: (args) => {
        const connection = this.requireConnection(String(args.server));
        return jsonResult(
          lint({
            tools: connection.catalog.tools,
            resources: connection.catalog.resources,
            prompts: connection.catalog.prompts,
          }),
        );
      },
    });

    this.role.register({
      tool: {
        name: 'generateMcpTests',
        description: 'Generates declarative test cases for a tool from its schema. Returns the cases; it does not save them.',
        inputSchema: {
          type: 'object',
          properties: {
            server: { type: 'string' },
            tool: { type: 'string' },
          },
          required: ['server', 'tool'],
        },
        annotations: { readOnlyHint: true },
      },
      handler: (args) => {
        const connection = this.requireConnection(String(args.server));
        const tool = connection.catalog.tools.find((t) => t.name === String(args.tool));
        if (!tool) {
          throw new Error(`No tool "${String(args.tool)}"`);
        }
        return jsonResult(generateTests(tool));
      },
    });

    this.role.register({
      tool: {
        name: 'runMcpTests',
        description: 'Runs the declarative MCP test suites in the open workspace.',
        inputSchema: {
          type: 'object',
          properties: { server: { type: 'string' } },
        },
        annotations: { readOnlyHint: true },
      },
      handler: async (args) => {
        const runner = new TestRunner(this.workbench.execution);
        const suites = this.workbench.tests.list();
        if (suites.length === 0) {
          return textResult('No test suites were found in this workspace.');
        }

        const results = [];
        for (const suite of suites) {
          const serverId = args.server
            ? this.workbench.resolveServerByName(String(args.server))
            : await this.workbench.resolveTestServer(suite, suite.tests[0] ?? { name: '' });
          if (!serverId) {
            continue;
          }
          results.push(await runner.runSuite(suite, serverId));
        }
        return jsonResult(
          results.map((result) => ({
            suite: result.suite.name,
            passed: result.passed,
            failed: result.failed,
            failures: result.results
              .filter((entry) => entry.status !== 'passed' && entry.status !== 'skipped')
              .map((entry) => ({ test: entry.test.name, message: entry.message })),
          })),
        );
      },
    });
  }

  private requireConnection(name: string) {
    const serverId = this.workbench.resolveServerByName(name);
    const connection = serverId ? this.workbench.manager.get(serverId) : undefined;
    if (!connection) {
      const known = this.workbench.manager
        .list()
        .map((entry) => entry.config.name)
        .join(', ');
      throw new Error(`No MCP server named "${name}". Configured servers: ${known || 'none'}`);
    }
    if (connection.status !== 'connected') {
      throw new Error(
        `"${connection.config.name}" is ${connection.status}. Ask the developer to connect it in MCP Lab.`,
      );
    }
    return connection;
  }

  dispose(): void {
    void this.stop();
  }
}
