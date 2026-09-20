import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  generateTypeScriptHandlers,
  toolsFromOpenApi,
  type OpenApiDocument,
} from '../src/core/openapi';
import type { JsonRpcResponse } from '../src/core/protocol';
import { scaffold } from '../src/core/scaffold';
import { jsonResult, McpServerRole } from '../src/core/serverRole';

// ---------------------------------------------------------------------------

describe('scaffold', () => {
  const options = {
    name: 'Deployment MCP',
    transport: 'stdio' as const,
    features: { tools: true, resources: true, prompts: true },
  };

  it('generates a buildable TypeScript project', () => {
    const files = scaffold({ ...options, language: 'typescript' });

    assert.ok(files['package.json']);
    assert.ok(files['tsconfig.json']);
    assert.ok(files['src/server.ts']);
    assert.ok(files['src/tools/index.ts']);

    const pkg = JSON.parse(files['package.json']) as {
      name: string;
      dependencies: Record<string, string>;
    };
    assert.equal(pkg.name, 'deployment-mcp');
    assert.ok(pkg.dependencies['@modelcontextprotocol/sdk']);

    assert.match(files['src/server.ts'], /StdioServerTransport/);
    // stdout is protocol on stdio, so the template must not print to it.
    assert.match(files['src/server.ts'], /console\.error/);
    assert.doesNotMatch(files['src/server.ts'], /console\.log/);
  });

  it('includes only the requested features', () => {
    const files = scaffold({
      ...options,
      language: 'typescript',
      features: { tools: true, resources: false, prompts: false },
    });
    assert.ok(files['src/tools/index.ts']);
    assert.ok(!files['src/resources/index.ts']);
    assert.ok(!files['src/prompts/index.ts']);
    assert.doesNotMatch(files['src/server.ts'], /registerPrompts/);
  });

  it('switches bootstrap code for the HTTP transport', () => {
    const files = scaffold({ ...options, language: 'typescript', transport: 'http' });
    assert.match(files['src/server.ts'], /StreamableHTTPServerTransport/);
    const config = JSON.parse(files['mcp.config.json']) as { servers: Array<{ transport: string }> };
    assert.equal(config.servers[0].transport, 'http');
  });

  it('generates a Python project with a destructive annotation', () => {
    const files = scaffold({ ...options, language: 'python' });
    assert.ok(files['pyproject.toml']);
    const server = files['src/deployment_mcp/server.py'];
    assert.ok(server, 'server module exists');
    assert.match(server, /FastMCP/);
    assert.match(server, /destructiveHint/);
  });

  it('generates a C# project that logs to stderr', () => {
    const files = scaffold({ ...options, language: 'csharp' });
    assert.ok(files['DeploymentMCP.csproj']);
    assert.match(files['Program.cs'], /LogToStandardErrorThreshold/);
    assert.match(files['Tools/ItemTools.cs'], /Destructive = true/);
  });

  it('always ships a Workbench config so the CLI can reach it', () => {
    for (const language of ['typescript', 'python', 'csharp'] as const) {
      const files = scaffold({ ...options, language });
      const config = JSON.parse(files['mcp.config.json']) as { servers: unknown[] };
      assert.equal(config.servers.length, 1, language);
      assert.match(files['README.md'], /mcpilot doctor/);
    }
  });
});

// ---------------------------------------------------------------------------

const PETSTORE: OpenApiDocument = {
  openapi: '3.0.0',
  info: { title: 'Events API', version: '1.0.0' },
  servers: [{ url: 'https://api.example.com/v1' }],
  paths: {
    '/events': {
      get: {
        operationId: 'listEvents',
        summary: 'Lists events.',
        parameters: [
          {
            name: 'environment',
            in: 'query',
            required: true,
            description: 'Which environment',
            schema: { type: 'string', enum: ['DEV', 'QC'] },
          },
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
        ],
        responses: {
          '200': {
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/EventList' } },
            },
          },
        },
      },
      post: {
        summary: 'Creates an event.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { title: { type: 'string' }, startsAt: { type: 'string', format: 'date-time' } },
                required: ['title'],
              },
            },
          },
        },
        responses: {},
      },
    },
    '/events/{eventId}': {
      delete: {
        operationId: 'deleteEvent',
        summary: 'Deletes an event.',
        parameters: [{ name: 'eventId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {},
      },
      get: {
        parameters: [
          { name: 'eventId', in: 'path', schema: { type: 'string' } },
          { name: 'x-api-key', in: 'header', schema: { type: 'string' } },
        ],
        responses: {},
      },
    },
  },
  components: {
    schemas: {
      EventList: {
        type: 'object',
        properties: { events: { type: 'array', items: { $ref: '#/components/schemas/Event' } } },
      },
      Event: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } },
    },
  },
};

describe('OpenAPI → MCP', () => {
  const generated = toolsFromOpenApi(PETSTORE);
  const byName = new Map(generated.map((entry) => [entry.tool.name, entry]));

  it('creates one tool per operation, using operationId where present', () => {
    assert.ok(byName.has('listEvents'));
    assert.ok(byName.has('deleteEvent'));
    // No operationId: a name is derived from the method and path.
    assert.ok(byName.has('postEvents'));
    assert.ok(byName.has('getEventsByEventId'));
  });

  it('maps HTTP verbs to annotations', () => {
    assert.equal(byName.get('listEvents')!.tool.annotations?.readOnlyHint, true);
    assert.equal(byName.get('deleteEvent')!.tool.annotations?.destructiveHint, true);
    assert.equal(byName.get('deleteEvent')!.tool.annotations?.idempotentHint, true);
  });

  it('folds query, path and body parameters into one input schema', () => {
    const list = byName.get('listEvents')!;
    assert.deepEqual(Object.keys(list.tool.inputSchema.properties ?? {}), ['environment', 'limit']);
    assert.deepEqual(list.tool.inputSchema.required, ['environment']);
    assert.deepEqual(list.binding.queryParams, ['environment', 'limit']);

    const create = byName.get('postEvents')!;
    assert.deepEqual(Object.keys(create.tool.inputSchema.properties ?? {}), ['title', 'startsAt']);
    assert.deepEqual(create.binding.bodyProperties, ['title', 'startsAt']);
    assert.deepEqual(create.tool.inputSchema.required, ['title']);
  });

  it('resolves $ref in the response schema', () => {
    const output = byName.get('listEvents')!.tool.outputSchema!;
    const events = output.properties?.events;
    assert.equal(events?.type, 'array');
    assert.equal((events?.items as { properties?: object })?.properties !== undefined, true);
  });

  it('treats a path parameter as required even when the document does not', () => {
    const entry = byName.get('getEventsByEventId')!;
    assert.ok(entry.tool.inputSchema.required?.includes('eventId'));
    assert.ok(entry.warnings.some((w) => /not marked required/.test(w)));
  });

  it('warns about a credential-shaped header parameter', () => {
    const entry = byName.get('getEventsByEventId')!;
    assert.ok(entry.warnings.some((w) => /looks like a credential/.test(w)));
  });

  it('generates handlers that build the URL and body correctly', () => {
    const code = generateTypeScriptHandlers(
      [byName.get('listEvents')!, byName.get('deleteEvent')!, byName.get('postEvents')!],
      'https://api.example.com/v1',
    );

    assert.match(code, /server\.registerTool\(\s*"listEvents"/);
    assert.match(code, /z\.enum\(\["DEV","QC"\]/);
    assert.match(code, /\.optional\(\)/, 'optional parameters are marked optional');
    assert.match(code, /encodeURIComponent\(String\(args\["eventId"\]\)\)/);
    assert.match(code, /method: "DELETE"/);
    assert.match(code, /isError: true/, 'HTTP failures are reported in-band');
    assert.match(code, /TODO: add auth headers/);
  });

  it('can filter by tag and skip deprecated operations', () => {
    const tagged: OpenApiDocument = {
      paths: {
        '/a': { get: { operationId: 'a', tags: ['keep'], responses: {} } },
        '/b': { get: { operationId: 'b', tags: ['drop'], responses: {} } },
        '/c': { get: { operationId: 'c', tags: ['keep'], deprecated: true, responses: {} } },
      },
    };
    const kept = toolsFromOpenApi(tagged, { tagFilter: 'keep' });
    assert.deepEqual(kept.map((entry) => entry.tool.name), ['a']);

    const withDeprecated = toolsFromOpenApi(tagged, { tagFilter: 'keep', includeDeprecated: true });
    assert.equal(withDeprecated.length, 2);
  });
});

// ---------------------------------------------------------------------------

describe('Workbench as an MCP server', () => {
  function role(options: { authorize?: () => boolean } = {}): McpServerRole {
    const server = new McpServerRole({
      name: 'mcpilot',
      version: '0.1.0',
      authorize: options.authorize,
    });
    server.register({
      tool: {
        name: 'listMcpServers',
        description: 'Lists servers.',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
      },
      handler: () => jsonResult([{ name: 'CMS' }]),
    });
    server.register({
      tool: {
        name: 'executeMcpTool',
        description: 'Runs a tool.',
        inputSchema: { type: 'object', properties: { tool: { type: 'string' } } },
      },
      handler: () => {
        throw new Error('backend exploded');
      },
    });
    return server;
  }

  async function call(server: McpServerRole, method: string, params?: unknown) {
    return (await server.handle({ jsonrpc: '2.0', id: 1, method, params })) as JsonRpcResponse;
  }

  it('completes the initialize handshake in the client’s protocol version', async () => {
    const response = (await call(role(), 'initialize', { protocolVersion: '2024-11-05' })) as {
      result: { protocolVersion: string; serverInfo: { name: string } };
    };
    assert.equal(response.result.protocolVersion, '2024-11-05');
    assert.equal(response.result.serverInfo.name, 'mcpilot');
  });

  it('falls back to the latest version for an unknown one', async () => {
    const response = (await call(role(), 'initialize', { protocolVersion: '1999-01-01' })) as {
      result: { protocolVersion: string };
    };
    assert.equal(response.result.protocolVersion, '2025-06-18');
  });

  it('lists and calls its tools', async () => {
    const server = role();
    const listed = (await call(server, 'tools/list')) as { result: { tools: Array<{ name: string }> } };
    assert.deepEqual(listed.result.tools.map((t) => t.name), ['listMcpServers', 'executeMcpTool']);

    const called = (await call(server, 'tools/call', { name: 'listMcpServers', arguments: {} })) as {
      result: { structuredContent: unknown };
    };
    assert.deepEqual(called.result.structuredContent, [{ name: 'CMS' }]);
  });

  it('reports a handler error in-band rather than as a protocol error', async () => {
    const response = (await call(role(), 'tools/call', {
      name: 'executeMcpTool',
      arguments: {},
    })) as { result: { isError: boolean; content: Array<{ text: string }> } };

    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /backend exploded/);
  });

  it('turns a refused authorization into an explainable result', async () => {
    const response = (await call(role({ authorize: () => false }), 'tools/call', {
      name: 'executeMcpTool',
      arguments: {},
    })) as { result: { isError: boolean; content: Array<{ text: string }> } };

    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /requires a human to approve/);
  });

  it('rejects an unknown tool and an unknown method', async () => {
    const unknownTool = (await call(role(), 'tools/call', { name: 'ghost' })) as {
      error: { code: number };
    };
    assert.equal(unknownTool.error.code, -32602);

    const unknownMethod = (await call(role(), 'resources/list')) as { error: { code: number } };
    assert.equal(unknownMethod.error.code, -32601);
  });

  it('does not answer notifications', async () => {
    const response = await role().handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(response, undefined);
  });
});
