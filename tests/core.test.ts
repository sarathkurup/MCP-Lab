import assert from 'node:assert/strict';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { ConnectionManager } from '../src/core/ConnectionManager';
import { deriveServerId, validateServerConfig } from '../src/core/config';
import { LogStore } from '../src/core/logging';
import { McpClient } from '../src/core/McpClient';
import { McpError } from '../src/core/protocol';
import { StdioTransport } from '../src/core/transport/StdioTransport';
import { StreamableHttpTransport } from '../src/core/transport/StreamableHttpTransport';
import { TraceStore } from '../src/core/trace';

// Fixtures stay plain JS next to the sources, so they are loaded by path rather
// than by a relative require that would break once the tests are compiled.
const DEMO_SERVER = path.resolve('tests/fixtures/demo-server.js');
const { startHttpServer } = require(path.resolve('tests/fixtures/http-server.js')) as {
  startHttpServer: (options?: { mode?: 'json' | 'sse'; requireAuth?: boolean }) => Promise<{
    url: string;
    seenHeaders: Array<{ method: string; headers: Record<string, string> }>;
    close: () => Promise<void>;
  }>;
};

function stdioClient(): McpClient {
  return new McpClient(
    new StdioTransport({ command: process.execPath, args: [DEMO_SERVER] }),
    { requestTimeoutMs: 10_000 },
  );
}

describe('config validation', () => {
  it('requires a command for stdio servers', () => {
    const issues = validateServerConfig({ name: 'x', transport: 'stdio' });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].field, 'command');
  });

  it('rejects a non-http URL', () => {
    const issues = validateServerConfig({
      name: 'x',
      transport: 'http',
      url: 'ftp://example.com',
    });
    assert.ok(issues.some((i) => i.field === 'url'));
  });

  it('derives unique ids', () => {
    assert.equal(deriveServerId('CMS MCP', []), 'cms-mcp');
    assert.equal(deriveServerId('CMS MCP', ['cms-mcp']), 'cms-mcp-2');
  });
});

describe('stdio transport', () => {
  it('initializes, lists and calls tools', async () => {
    const client = stdioClient();
    const stderr: string[] = [];
    client.onStderr((chunk) => stderr.push(chunk));

    const result = await client.initialize();
    assert.equal(result.serverInfo.name, 'demo-mcp');
    assert.equal(client.protocolVersion, '2025-06-18');

    const tools = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name),
      ['echo', 'add', 'deleteEvent', 'slowQuery'],
    );

    const echoed = await client.callTool('echo', { message: 'hello', shout: true });
    assert.equal((echoed.content[0] as { text: string }).text, 'HELLO');

    const added = await client.callTool('add', { a: 2, b: 40 });
    assert.deepEqual(added.structuredContent, { sum: 42 });

    const resources = await client.listResources();
    assert.equal(resources[0].uri, 'file:///demo/templates.json');

    const read = await client.readResource('file:///demo/templates.json');
    assert.ok('text' in read.contents[0]);

    const prompts = await client.listPrompts();
    assert.equal(prompts[0].name, 'analyze_customer');

    const prompt = await client.getPrompt('analyze_customer', { customerId: '42' });
    assert.match((prompt.messages[0].content as { text: string }).text, /customer 42/);

    assert.ok(stderr.join('').includes('demo-mcp ready'), 'stderr is captured, not parsed');
    await client.close();
  });

  it('follows pagination cursors', async () => {
    const client = new McpClient(
      new StdioTransport({
        command: process.execPath,
        // The fixture pages one tool at a time when asked.
        args: ['-e', pagedServerScript()],
      }),
      { requestTimeoutMs: 10_000 },
    );
    await client.initialize();
    const tools = await client.listTools();
    assert.equal(tools.length, 4, 'all pages were collected');
    await client.close();
  });

  it('surfaces server errors as McpError', async () => {
    const client = stdioClient();
    await client.initialize();
    await assert.rejects(
      () => client.callTool('nope', {}),
      (err: unknown) => err instanceof McpError && err.code === -32602,
    );
    await client.close();
  });

  it('fails cleanly when the command does not exist', async () => {
    const client = new McpClient(
      new StdioTransport({ command: 'definitely-not-a-real-binary-xyz', args: [] }),
      { requestTimeoutMs: 3000 },
    );
    await assert.rejects(() => client.initialize());
    await client.close();
  });
});

describe('streamable http transport', () => {
  const servers: Array<{ close: () => Promise<void> }> = [];
  after(async () => {
    await Promise.all(servers.map((s) => s.close()));
  });

  for (const mode of ['json', 'sse'] as const) {
    it(`initializes and calls tools over ${mode} responses`, async () => {
      const fixture = await startHttpServer({ mode });
      servers.push(fixture);

      const client = new McpClient(new StreamableHttpTransport({ url: fixture.url }), {
        requestTimeoutMs: 10_000,
      });
      const result = await client.initialize();
      assert.equal(result.serverInfo.name, 'demo-mcp');

      const tools = await client.listTools();
      assert.equal(tools.length, 4);

      const echoed = await client.callTool('echo', { message: 'over http' });
      assert.equal((echoed.content[0] as { text: string }).text, 'over http');

      // The session id handed back on initialize must ride along afterwards.
      const withSession = fixture.seenHeaders.filter(
        (h: { headers: Record<string, string> }) => h.headers['mcp-session-id'],
      );
      assert.ok(withSession.length > 0, 'session id was echoed back to the server');

      await client.close();
    });
  }

  it('sends the bearer token from the auth provider', async () => {
    const fixture = await startHttpServer({ mode: 'json', requireAuth: true });
    servers.push(fixture);

    const client = new McpClient(
      new StreamableHttpTransport({
        url: fixture.url,
        authProvider: async () => ({ authorization: 'Bearer s3cret' }),
      }),
      { requestTimeoutMs: 10_000 },
    );
    await client.initialize();
    await client.close();
  });

  it('reports an HTTP failure rather than hanging', async () => {
    const fixture = await startHttpServer({ mode: 'json', requireAuth: true });
    servers.push(fixture);

    const client = new McpClient(new StreamableHttpTransport({ url: fixture.url }), {
      requestTimeoutMs: 5000,
    });
    await assert.rejects(() => client.initialize(), /401/);
    await client.close();
  });
});

describe('capability gating', () => {
  it('refuses a primitive the server never advertised', async () => {
    const client = new McpClient(
      new StdioTransport({ command: process.execPath, args: ['-e', toolsOnlyScript()] }),
      { requestTimeoutMs: 5000 },
    );
    await client.initialize();
    await assert.rejects(
      () => client.listPrompts(),
      (err: unknown) => err instanceof McpError && /prompts/.test(err.message),
    );
    await client.close();
  });
});

describe('connection manager', () => {
  it('tracks status, catalog and trace for a server', async () => {
    const logs = new LogStore();
    const trace = new TraceStore();
    const manager = new ConnectionManager({
      logs,
      trace,
      requestTimeoutMs: () => 10_000,
    });

    const statuses: string[] = [];
    manager.onDidChangeStatus((e) => statuses.push(e.status));

    await manager.sync([
      {
        id: 'demo',
        name: 'Demo',
        transport: 'stdio',
        command: process.execPath,
        args: [DEMO_SERVER],
      },
    ]);

    await manager.connect('demo');
    const connection = manager.get('demo');
    assert.equal(connection?.status, 'connected');
    assert.equal(connection?.catalog.tools.length, 4);
    assert.equal(connection?.catalog.prompts.length, 1);
    assert.deepEqual(statuses, ['connecting', 'connected']);

    const frames = trace.list('demo');
    assert.ok(frames.some((f) => f.method === 'initialize'));
    assert.ok(
      frames.some((f) => f.kind === 'response' && typeof f.durationMs === 'number'),
      'responses are timed',
    );

    await manager.disconnect('demo');
    assert.equal(manager.get('demo')?.status, 'disconnected');
    assert.equal(manager.get('demo')?.catalog.tools.length, 0);

    await manager.disposeAll();
  });

  it('removing a server clears its logs and trace', async () => {
    const logs = new LogStore();
    const trace = new TraceStore();
    const manager = new ConnectionManager({
      logs,
      trace,
      requestTimeoutMs: () => 10_000,
    });

    await manager.sync([
      {
        id: 'demo',
        name: 'Demo',
        transport: 'stdio',
        command: process.execPath,
        args: [DEMO_SERVER],
      },
    ]);
    await manager.connect('demo');
    assert.ok(trace.list('demo').length > 0);

    await manager.remove('demo');
    assert.equal(trace.list('demo').length, 0);
    assert.equal(logs.query({ serverId: 'demo' }).length, 0);
    assert.equal(manager.list().length, 0);

    await manager.disposeAll();
  });
});

/** An inline server that pages tools one at a time. */
function pagedServerScript(): string {
  return `
    const { createHandler } = require(${JSON.stringify(DEMO_SERVER)});
    const handle = createHandler({ pageSize: 1 });
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const res = handle(JSON.parse(line));
        if (res) process.stdout.write(JSON.stringify(res) + '\\n');
      }
    });
  `;
}

/** An inline server that advertises tools only. */
function toolsOnlyScript(): string {
  return `
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id == null) continue;
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0', id: msg.id, result: {
              protocolVersion: '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'tools-only', version: '1.0.0' },
            },
          }) + '\\n');
        } else if (msg.method === 'tools/list') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0', id: msg.id, result: { tools: [] },
          }) + '\\n');
        } else {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' },
          }) + '\\n');
        }
      }
    });
  `;
}
