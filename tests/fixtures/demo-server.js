'use strict';
/**
 * A dependency-free MCP server used to test Workbench's core.
 * Run directly for stdio; `createHandler()` is reused by the HTTP fixture.
 *
 * This doubles as the seed of the demo environment: it exposes one read-only
 * tool, one destructive tool, a resource and a prompt.
 */

const PROTOCOL_VERSION = '2025-06-18';

const TOOLS = [
  {
    name: 'echo',
    description: 'Returns the message it is given.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Text to echo back' },
        shout: { type: 'boolean', description: 'Uppercase the reply', default: false },
      },
      required: ['message'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'add',
    description: 'Adds two numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'number' },
        b: { type: 'number' },
      },
      required: ['a', 'b'],
    },
    outputSchema: {
      type: 'object',
      properties: { sum: { type: 'number' } },
      required: ['sum'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'deleteEvent',
    description: 'Deletes an event. Present so destructive-tool handling can be tested.',
    inputSchema: {
      type: 'object',
      properties: { eventId: { type: 'string' } },
      required: ['eventId'],
    },
    annotations: { destructiveHint: true },
  },
];

const RESOURCES = [
  {
    uri: 'file:///demo/templates.json',
    name: 'templates',
    description: 'Demo templates',
    mimeType: 'application/json',
  },
];

const PROMPTS = [
  {
    name: 'analyze_customer',
    description: 'Analyzes a customer record.',
    arguments: [
      { name: 'customerId', description: 'Customer identifier', required: true },
      { name: 'environment', description: 'DEV | QC | PROD', required: false },
    ],
  },
];

function createHandler(options = {}) {
  const pageSize = options.pageSize ?? TOOLS.length;

  return function handle(message) {
    const { id, method, params } = message;

    // Notifications get no reply.
    if (id === undefined || id === null) {
      return undefined;
    }

    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    const fail = (code, msg) => ({ jsonrpc: '2.0', id, error: { code, message: msg } });

    switch (method) {
      case 'initialize':
        return ok({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} },
          serverInfo: { name: 'demo-mcp', version: '1.0.0' },
          instructions: 'Demo server for MCP Workbench tests.',
        });

      case 'ping':
        return ok({});

      case 'tools/list': {
        // Paginated so the client's cursor handling is exercised.
        const start = params && params.cursor ? Number(params.cursor) : 0;
        const slice = TOOLS.slice(start, start + pageSize);
        const next = start + pageSize < TOOLS.length ? String(start + pageSize) : undefined;
        return ok(next ? { tools: slice, nextCursor: next } : { tools: slice });
      }

      case 'tools/call': {
        const name = params && params.name;
        const args = (params && params.arguments) || {};
        if (name === 'echo') {
          if (typeof args.message !== 'string') {
            return fail(-32602, 'message must be a string');
          }
          const text = args.shout ? args.message.toUpperCase() : args.message;
          return ok({ content: [{ type: 'text', text }] });
        }
        if (name === 'add') {
          const sum = Number(args.a) + Number(args.b);
          return ok({
            content: [{ type: 'text', text: String(sum) }],
            structuredContent: { sum },
          });
        }
        if (name === 'deleteEvent') {
          return ok({
            content: [{ type: 'text', text: `Deleted ${args.eventId}` }],
          });
        }
        return fail(-32602, `Unknown tool: ${name}`);
      }

      case 'resources/list':
        return ok({ resources: RESOURCES });

      case 'resources/templates/list':
        return ok({ resourceTemplates: [] });

      case 'resources/read': {
        const uri = params && params.uri;
        const resource = RESOURCES.find((r) => r.uri === uri);
        if (!resource) {
          return fail(-32602, `Unknown resource: ${uri}`);
        }
        return ok({
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify({ templates: ['welcome', 'reminder'] }, null, 2),
            },
          ],
        });
      }

      case 'prompts/list':
        return ok({ prompts: PROMPTS });

      case 'prompts/get': {
        const name = params && params.name;
        if (name !== 'analyze_customer') {
          return fail(-32602, `Unknown prompt: ${name}`);
        }
        const args = (params && params.arguments) || {};
        return ok({
          description: 'Customer analysis',
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Analyze customer ${args.customerId} in ${args.environment || 'DEV'}.`,
              },
            },
          ],
        });
      }

      case 'logging/setLevel':
        return ok({});

      default:
        return fail(-32601, `Method not found: ${method}`);
    }
  };
}

function runStdio() {
  const handle = createHandler();
  let buffer = '';

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (line.trim()) {
        let response;
        try {
          response = handle(JSON.parse(line));
        } catch (err) {
          response = {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: String(err) },
          };
        }
        if (response) {
          process.stdout.write(JSON.stringify(response) + '\n');
        }
      }
      newline = buffer.indexOf('\n');
    }
  });

  // Proves stderr is captured as logs rather than parsed as protocol.
  process.stderr.write('demo-mcp ready\n');
}

module.exports = { createHandler, PROTOCOL_VERSION, TOOLS };

if (require.main === module) {
  runStdio();
}
