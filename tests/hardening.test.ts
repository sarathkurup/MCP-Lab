import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ConnectionManager } from '../src/core/ConnectionManager';
import { LogStore } from '../src/core/logging';
import { containsSecret, redact, redactValue } from '../src/core/redaction';
import { TraceStore } from '../src/core/trace';

const DEMO_SERVER = path.resolve('tests/fixtures/demo-server.js');

describe('redaction', () => {
  it('masks bearer tokens and authorization headers', () => {
    assert.match(redact('Authorization: Bearer abcdef1234567890abcdef'), /redacted/);
    assert.doesNotMatch(redact('Authorization: Bearer abcdef1234567890abcdef'), /abcdef1234567890/);
    assert.match(redact('sent Bearer abcdef1234567890abcdef to the API'), /Bearer \*\*\*redacted\*\*\*/);
  });

  it('masks provider-specific token formats', () => {
    for (const secret of [
      'AKIAIOSFODNN7EXAMPLE',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'xoxb-1234567890-abcdefghij',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijkl',
    ]) {
      const masked = redact(`value=${secret}`);
      assert.ok(!masked.includes(secret), `${secret} should be masked, got: ${masked}`);
    }
  });

  it('masks assignments to secret-looking keys', () => {
    assert.doesNotMatch(redact('password: hunter2000'), /hunter2000/);
    assert.doesNotMatch(redact('api_key="abcdef123456"'), /abcdef123456/);
    assert.doesNotMatch(redact('client_secret = s3cr3tvalue'), /s3cr3tvalue/);
  });

  it('masks a private key block', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----';
    assert.doesNotMatch(redact(key), /MIIEow/);
  });

  it('leaves ordinary text alone', () => {
    const text = 'Connected to CMS MCP in 42ms with 18 tools';
    assert.equal(redact(text), text);
    assert.equal(containsSecret(text), false);
  });

  it('masks inside a structure while keeping its shape', () => {
    const redacted = redactValue({
      user: 'sam',
      nested: { token: 'abcdefghijklmnop', count: 3 },
      list: ['Bearer abcdefghijklmnopqrst', 'plain'],
    }) as { user: string; nested: { token: string; count: number }; list: string[] };

    assert.equal(redacted.user, 'sam');
    assert.equal(redacted.nested.count, 3, 'non-string values survive');
    assert.equal(redacted.nested.token, '***redacted***', 'a secret-named field is masked outright');
    assert.match(redacted.list[0], /redacted/);
    assert.equal(redacted.list[1], 'plain');
  });

  it('is applied to log lines as they are stored', () => {
    const logs = new LogStore();
    logs.log('info', 'calling with Authorization: Bearer abcdefghijklmnopqrst');

    const stored = logs.query()[0];
    assert.doesNotMatch(stored.message, /abcdefghijklmnopqrst/);

    const off = new LogStore(100, false);
    off.log('info', 'Bearer abcdefghijklmnopqrst');
    assert.match(off.query()[0].message, /abcdefghijklmnopqrst/, 'opt-out is honoured');
  });
});

describe('reconnection', () => {
  it('retries a server that dies, then gives up at the limit', async () => {
    const logs = new LogStore();
    const manager = new ConnectionManager({
      logs,
      trace: new TraceStore(),
      requestTimeoutMs: () => 3000,
      maxReconnectAttempts: () => 2,
    });

    // A server that exits as soon as it is initialized.
    await manager.sync([
      {
        id: 'flaky',
        name: 'Flaky',
        transport: 'stdio',
        command: process.execPath,
        args: ['-e', suicidalServerScript()],
      },
    ]);

    // The first connect may itself fail if the child dies before replying;
    // either way the retry loop is what this test is about.
    await manager.connect('flaky').catch(() => undefined);
    const connection = manager.get('flaky')!;

    await waitFor(() => logs.query({ serverId: 'flaky' }).some((e) => /Giving up/.test(e.message)), 8000);

    const messages = logs.query({ serverId: 'flaky' }).map((entry) => entry.message);
    assert.ok(messages.some((m) => /Reconnecting in \d+ms \(attempt 1\/2\)/.test(m)));
    assert.ok(messages.some((m) => /Reconnecting in \d+ms \(attempt 2\/2\)/.test(m)));
    assert.ok(messages.some((m) => /Giving up after 2 reconnection attempt/.test(m)));
    assert.equal(connection.status, 'error');

    await manager.disposeAll();
  });

  it('does not retry a connection the user closed', async () => {
    const logs = new LogStore();
    const manager = new ConnectionManager({
      logs,
      trace: new TraceStore(),
      requestTimeoutMs: () => 3000,
      maxReconnectAttempts: () => 3,
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
    await manager.disconnect('demo');

    await new Promise((resolve) => setTimeout(resolve, 600));

    const messages = logs.query({ serverId: 'demo' }).map((entry) => entry.message);
    assert.ok(!messages.some((m) => /Reconnecting/.test(m)), 'no retry after a deliberate disconnect');
    assert.equal(manager.get('demo')?.status, 'disconnected');

    await manager.disposeAll();
  });

  it('honours maxReconnectAttempts of 0', async () => {
    const logs = new LogStore();
    const manager = new ConnectionManager({
      logs,
      trace: new TraceStore(),
      requestTimeoutMs: () => 3000,
      maxReconnectAttempts: () => 0,
    });

    await manager.sync([
      {
        id: 'flaky',
        name: 'Flaky',
        transport: 'stdio',
        command: process.execPath,
        args: ['-e', suicidalServerScript()],
      },
    ]);
    await manager.connect('flaky').catch(() => undefined);

    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.ok(
      !logs.query({ serverId: 'flaky' }).some((entry) => /Reconnecting/.test(entry.message)),
    );

    await manager.disposeAll();
  });
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Condition was not met in time');
}

/** Answers initialize, then exits - the "server restarted mid-session" case. */
function suicidalServerScript(): string {
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
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({
            jsonrpc: '2.0', id: msg.id, result: {
              protocolVersion: '2025-06-18',
              capabilities: {},
              serverInfo: { name: 'flaky', version: '1.0.0' },
            },
          }) + '\\n', () => setTimeout(() => process.exit(1), 50));
        }
      }
    });
  `;
}
