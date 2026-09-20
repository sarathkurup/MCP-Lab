'use strict';
/**
 * A tiny MCP server framework for the demo environment.
 *
 * Dependency-free on purpose: the demo has to run immediately after cloning,
 * with no install step, on whatever Node the developer already has.
 */

const PROTOCOL_VERSION = '2025-06-18';

function createDemoServer(spec) {
  const tools = spec.tools ?? [];
  const resources = spec.resources ?? [];
  const prompts = spec.prompts ?? [];

  async function handle(message) {
    const { id, method, params } = message;
    if (id === undefined || id === null) {
      return undefined;
    }

    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    const fail = (code, msg) => ({ jsonrpc: '2.0', id, error: { code, message: msg } });

    switch (method) {
      case 'initialize':
        return ok({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {
            tools: {},
            ...(resources.length ? { resources: {} } : {}),
            ...(prompts.length ? { prompts: {} } : {}),
            logging: {},
          },
          serverInfo: { name: spec.name, version: spec.version },
          instructions: spec.instructions,
        });

      case 'ping':
        return ok({});

      case 'tools/list':
        return ok({ tools: tools.map(({ handler, ...rest }) => rest) });

      case 'tools/call': {
        const definition = tools.find((tool) => tool.name === params?.name);
        if (!definition) {
          return fail(-32602, `Unknown tool: ${params?.name}`);
        }

        const args = params?.arguments ?? {};
        const problem = validate(definition.inputSchema, args);
        if (problem) {
          return fail(-32602, problem);
        }

        try {
          const result = await definition.handler(args);
          return ok(result);
        } catch (err) {
          // A server-side failure is reported in-band, as MCP intends.
          return ok({
            isError: true,
            content: [{ type: 'text', text: String(err && err.message ? err.message : err) }],
          });
        }
      }

      case 'resources/list':
        return ok({ resources: resources.map(({ read, ...rest }) => rest) });

      case 'resources/templates/list':
        return ok({ resourceTemplates: [] });

      case 'resources/read': {
        const resource = resources.find((entry) => entry.uri === params?.uri);
        if (!resource) {
          return fail(-32602, `Unknown resource: ${params?.uri}`);
        }
        return ok({
          contents: [
            {
              uri: resource.uri,
              mimeType: resource.mimeType ?? 'text/plain',
              text: await resource.read(),
            },
          ],
        });
      }

      case 'prompts/list':
        return ok({ prompts: prompts.map(({ build, ...rest }) => rest) });

      case 'prompts/get': {
        const prompt = prompts.find((entry) => entry.name === params?.name);
        if (!prompt) {
          return fail(-32602, `Unknown prompt: ${params?.name}`);
        }
        return ok({
          description: prompt.description,
          messages: prompt.build(params?.arguments ?? {}),
        });
      }

      case 'logging/setLevel':
        return ok({});

      default:
        return fail(-32601, `Method not found: ${method}`);
    }
  }

  return { handle, spec };
}

/** Required fields, declared types and enums. Deliberately minimal. */
function validate(schema, value) {
  if (!schema || schema.type !== 'object') {
    return undefined;
  }
  for (const name of schema.required ?? []) {
    if (value[name] === undefined || value[name] === null || value[name] === '') {
      return `${name} is required`;
    }
  }
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    const entry = value[name];
    if (entry === undefined) {
      continue;
    }
    if (property.enum && !property.enum.includes(entry)) {
      return `${name} must be one of ${property.enum.join(', ')}`;
    }
    if (!property.type) {
      continue;
    }
    const actual = Array.isArray(entry) ? 'array' : entry === null ? 'null' : typeof entry;
    const matches =
      property.type === 'integer'
        ? Number.isInteger(entry)
        : property.type === 'number'
          ? actual === 'number'
          : property.type === actual;
    if (!matches) {
      return `${name} must be a ${property.type}`;
    }
  }
  return undefined;
}

function runStdio(server) {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (line.trim()) {
        let message;
        try {
          message = JSON.parse(line);
        } catch (err) {
          process.stdout.write(
            JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: String(err) } }) + '\n',
          );
          newline = buffer.indexOf('\n');
          continue;
        }
        server.handle(message).then((response) => {
          if (response) {
            process.stdout.write(JSON.stringify(response) + '\n');
          }
        });
      }
      newline = buffer.indexOf('\n');
    }
  });

  // stdout is protocol; everything human-readable goes to stderr.
  process.stderr.write(`${server.spec.name} ready\n`);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { createDemoServer, runStdio, delay, PROTOCOL_VERSION };
