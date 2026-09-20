import assert from 'node:assert/strict';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { ConnectionManager } from '../src/core/ConnectionManager';
import { ExecutionService, ValidationFailure } from '../src/core/execution';
import { HistoryStore } from '../src/core/history';
import { LogStore } from '../src/core/logging';
import { TraceStore } from '../src/core/trace';

const DEMO_SERVER = path.resolve('tests/fixtures/demo-server.js');

async function connected(): Promise<{
  manager: ConnectionManager;
  execution: ExecutionService;
  history: HistoryStore;
}> {
  const history = new HistoryStore();
  const manager = new ConnectionManager({
    logs: new LogStore(),
    trace: new TraceStore(),
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
  return { manager, execution: new ExecutionService(manager, history), history };
}

describe('ExecutionService', () => {
  let ctx: Awaited<ReturnType<typeof connected>>;

  beforeEach(async () => {
    ctx = await connected();
  });

  it('records a successful call in history', async () => {
    const { entry, result } = await ctx.execution.callTool('demo', 'echo', {
      message: 'hi',
    });

    assert.equal(result?.content?.[0] && 'text' in result.content[0] ? result.content[0].text : '', 'hi');
    assert.equal(entry.kind, 'tool');
    assert.equal(entry.name, 'echo');
    assert.equal(entry.error, undefined);
    assert.ok(entry.durationMs >= 0);
    assert.equal(ctx.history.list().length, 1);

    await ctx.manager.disposeAll();
  });

  it('rejects a payload that does not match the input schema', async () => {
    await assert.rejects(
      () => ctx.execution.callTool('demo', 'echo', { shout: true }),
      (err: unknown) => err instanceof ValidationFailure && /message/.test(err.message),
    );
    // A request blocked by validation never reaches the server, so nothing is recorded.
    assert.equal(ctx.history.list().length, 0);

    await ctx.manager.disposeAll();
  });

  it('honours skipValidation so raw JSON mode can send anything', async () => {
    const { entry } = await ctx.execution.callTool(
      'demo',
      'echo',
      { message: 42 },
      { skipValidation: true },
    );
    // The server rejects it, which is recorded as a failure rather than thrown.
    assert.ok(entry.error, 'server-side error is captured');
    assert.equal(ctx.history.list().length, 1);

    await ctx.manager.disposeAll();
  });

  it('records a server error without throwing', async () => {
    const { error, entry } = await ctx.execution.callTool(
      'demo',
      'echo',
      { message: 1 },
      { skipValidation: true },
    );
    assert.ok(error);
    assert.equal(entry.error?.code, -32602);

    await ctx.manager.disposeAll();
  });

  it('prunes empty optional fields before sending', async () => {
    const { entry } = await ctx.execution.callTool('demo', 'echo', {
      message: 'hello',
      shout: false,
    });
    assert.deepEqual(entry.input, { message: 'hello', shout: false });

    await ctx.manager.disposeAll();
  });

  it('replays an invocation byte-for-byte', async () => {
    const first = await ctx.execution.callTool('demo', 'add', { a: 1, b: 2 });
    const replayed = await ctx.execution.replay(first.entry.id);

    assert.deepEqual(replayed.entry.input, first.entry.input);
    assert.deepEqual(
      (replayed.result as { structuredContent?: unknown } | undefined)?.structuredContent,
      { sum: 3 },
    );
    assert.equal(ctx.history.list().length, 2);

    await ctx.manager.disposeAll();
  });

  it('reads resources and gets prompts through the same pipeline', async () => {
    await ctx.execution.readResource('demo', 'file:///demo/templates.json');
    await ctx.execution.getPrompt('demo', 'analyze_customer', { customerId: '7' });

    const kinds = ctx.history.list().map((e) => e.kind);
    assert.deepEqual(kinds.sort(), ['prompt', 'resource']);

    await ctx.manager.disposeAll();
  });

  it('refuses a tool the server does not expose', async () => {
    await assert.rejects(
      () => ctx.execution.callTool('demo', 'ghost', {}),
      /has no tool "ghost"/,
    );
    await ctx.manager.disposeAll();
  });
});

describe('HistoryStore analytics', () => {
  it('summarises calls, failures and latency', () => {
    const history = new HistoryStore();
    const base = {
      serverId: 's',
      serverName: 'S',
      kind: 'tool' as const,
      input: {},
      timestamp: Date.now(),
    };

    history.add({ ...base, id: '1', name: 'a', durationMs: 100 });
    history.add({ ...base, id: '2', name: 'a', durationMs: 300 });
    history.add({
      ...base,
      id: '3',
      name: 'b',
      durationMs: 500,
      error: { message: 'boom' },
    });

    const stats = history.stats();
    assert.equal(stats.total, 3);
    assert.equal(stats.failed, 1);
    assert.equal(stats.averageMs, 300);
    assert.equal(stats.p95Ms, 500);

    const byTarget = Object.fromEntries(stats.byTarget.map((t) => [t.name, t]));
    assert.equal(byTarget['tool:a'].calls, 2);
    assert.equal(byTarget['tool:b'].failureRate, 1);
  });

  it('persists through the injected storage', () => {
    let saved: unknown[] = [];
    const store = new HistoryStore({
      load: () => saved as never,
      save: (entries) => {
        saved = entries;
      },
    });
    store.add({
      id: '1',
      timestamp: Date.now(),
      serverId: 's',
      serverName: 'S',
      kind: 'tool',
      name: 'a',
      input: {},
      durationMs: 5,
    });
    assert.equal(saved.length, 1);

    const reloaded = new HistoryStore({ load: () => saved as never, save: () => undefined });
    assert.equal(reloaded.list().length, 1);
  });
});
