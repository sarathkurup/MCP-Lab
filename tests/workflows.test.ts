import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { buildCatalogEntry, diffCatalogKeys, searchCatalog } from '../src/core/catalog';
import { ConnectionManager } from '../src/core/ConnectionManager';
import { ExecutionService } from '../src/core/execution';
import { HistoryStore, type HistoryEntry } from '../src/core/history';
import { LogStore } from '../src/core/logging';
import type { Tool } from '../src/core/protocol';
import { Recorder } from '../src/core/recording';
import { TraceStore } from '../src/core/trace';
import {
  buildWorkflowGraph,
  resolveTemplates,
  validateWorkflow,
  workflowFromHistory,
  WorkflowRunner,
  type Workflow,
} from '../src/core/workflows';

const DEMO_SERVER = path.resolve('tests/fixtures/demo-server.js');

async function connected() {
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
  const history = new HistoryStore();
  return { manager, history, execution: new ExecutionService(manager, history) };
}

// ---------------------------------------------------------------------------

describe('template resolution', () => {
  const outputs = new Map<string, unknown>([
    ['getUser', { structuredContent: { id: 42, name: 'Sam' }, content: [{ text: 'hi' }] }],
  ]);

  it('keeps the referenced type when a string is one whole reference', () => {
    const resolved = resolveTemplates('{{steps.getUser.output.structuredContent.id}}', outputs);
    assert.equal(resolved, 42);
    assert.equal(typeof resolved, 'number');
  });

  it('interpolates a reference inside a larger string', () => {
    assert.equal(
      resolveTemplates('user-{{steps.getUser.output.structuredContent.id}}', outputs),
      'user-42',
    );
  });

  it('walks nested objects and arrays', () => {
    const resolved = resolveTemplates(
      {
        userId: '{{steps.getUser.output.structuredContent.id}}',
        tags: ['{{steps.getUser.output.structuredContent.name}}', 'static'],
      },
      outputs,
    ) as { userId: number; tags: string[] };

    assert.equal(resolved.userId, 42);
    assert.deepEqual(resolved.tags, ['Sam', 'static']);
  });

  it('throws on a reference to a step that has not run', () => {
    assert.throws(
      () => resolveTemplates('{{steps.nope.output.x}}', outputs),
      /Cannot resolve/,
    );
  });

  it('leaves non-template values alone', () => {
    assert.equal(resolveTemplates('plain', outputs), 'plain');
    assert.equal(resolveTemplates(7, outputs), 7);
  });
});

describe('workflow validation', () => {
  it('catches duplicate ids, dangling targets and forward references', () => {
    const workflow: Workflow = {
      id: 'w',
      name: 'w',
      steps: [
        { id: 'a', kind: 'tool', tool: 'echo', input: { m: '{{steps.b.output.x}}' } },
        { id: 'a', kind: 'tool', tool: 'echo' },
        { id: 'b', kind: 'tool', next: 'ghost' },
      ],
    };

    const problems = validateWorkflow(workflow);
    assert.ok(problems.some((p) => /Duplicate step id/.test(p)));
    assert.ok(problems.some((p) => /unknown step "ghost"/.test(p)));
    assert.ok(problems.some((p) => /does not run before it/.test(p)));
    assert.ok(problems.some((p) => /no tool name/.test(p)));
  });

  it('accepts a well-formed workflow', () => {
    const workflow: Workflow = {
      id: 'w',
      name: 'w',
      steps: [
        { id: 'first', kind: 'tool', tool: 'add', input: { a: 1, b: 2 } },
        {
          id: 'second',
          kind: 'tool',
          tool: 'echo',
          input: { message: '{{steps.first.output.structuredContent.sum}}' },
        },
      ],
    };
    assert.deepEqual(validateWorkflow(workflow), []);
  });
});

describe('WorkflowRunner', () => {
  it('chains one tool’s output into the next tool’s input', async () => {
    const ctx = await connected();
    const runner = new WorkflowRunner(ctx.execution, () => 'demo');

    const run = await runner.run({
      id: 'chain',
      name: 'chain',
      steps: [
        { id: 'sum', kind: 'tool', tool: 'add', input: { a: 20, b: 22 } },
        {
          id: 'echo',
          kind: 'tool',
          tool: 'echo',
          // The whole point of chaining: 42 flows from one step to the next.
          input: { message: 'answer is {{steps.sum.output.structuredContent.sum}}' },
        },
      ],
    });

    assert.equal(run.status, 'completed');
    assert.equal(run.steps.length, 2);
    assert.equal(run.steps[1].input && (run.steps[1].input as { message: string }).message, 'answer is 42');

    await ctx.manager.disposeAll();
  });

  it('follows a branch based on an earlier result', async () => {
    const ctx = await connected();
    const runner = new WorkflowRunner(ctx.execution, () => 'demo');

    const workflow: Workflow = {
      id: 'branching',
      name: 'branching',
      steps: [
        { id: 'sum', kind: 'tool', tool: 'add', input: { a: 1, b: 1 } },
        {
          id: 'check',
          kind: 'branch',
          input: '{{steps.sum.output}}',
          condition: { path: '$.structuredContent.sum', equals: 2 },
          onTrue: 'yes',
          onFalse: 'no',
        },
        { id: 'yes', kind: 'tool', tool: 'echo', input: { message: 'two' } },
        { id: 'no', kind: 'tool', tool: 'echo', input: { message: 'not two' } },
      ],
    };

    const run = await runner.run(workflow);
    assert.equal(run.steps[1].status, 'branch-true');
    assert.equal(run.steps[2].stepId, 'yes');
    // The false branch must not run.
    assert.ok(!run.steps.some((step) => step.stepId === 'no'));

    await ctx.manager.disposeAll();
  });

  it('stops on failure unless the step opts out', async () => {
    const ctx = await connected();
    const runner = new WorkflowRunner(ctx.execution, () => 'demo');

    const stopping = await runner.run({
      id: 'stop',
      name: 'stop',
      steps: [
        { id: 'bad', kind: 'tool', tool: 'echo', input: { message: 123 } },
        { id: 'after', kind: 'tool', tool: 'echo', input: { message: 'ok' } },
      ],
    });
    assert.equal(stopping.status, 'failed');
    assert.equal(stopping.steps.length, 1);

    const continuing = await runner.run({
      id: 'go',
      name: 'go',
      steps: [
        { id: 'bad', kind: 'tool', tool: 'echo', input: { message: 123 }, continueOnError: true },
        { id: 'after', kind: 'tool', tool: 'echo', input: { message: 'ok' } },
      ],
    });
    assert.equal(continuing.status, 'completed');
    assert.equal(continuing.steps.length, 2);

    await ctx.manager.disposeAll();
  });

  it('breaks a cycle rather than looping forever', async () => {
    const ctx = await connected();
    const runner = new WorkflowRunner(ctx.execution, () => 'demo');

    const run = await runner.run({
      id: 'loop',
      name: 'loop',
      steps: [
        { id: 'a', kind: 'tool', tool: 'echo', input: { message: 'a' }, next: 'b' },
        { id: 'b', kind: 'tool', tool: 'echo', input: { message: 'b' }, next: 'a' },
      ],
    });

    assert.equal(run.status, 'failed');
    assert.match(run.steps[run.steps.length - 1].error!, /cycle/);

    await ctx.manager.disposeAll();
  });

  it('reports an unresolvable reference as a step failure', async () => {
    const ctx = await connected();
    const runner = new WorkflowRunner(ctx.execution, () => 'demo');

    const run = await runner.run({
      id: 'bad-ref',
      name: 'bad-ref',
      steps: [
        { id: 'only', kind: 'tool', tool: 'echo', input: { message: '{{steps.ghost.output.x}}' } },
      ],
    });

    assert.equal(run.status, 'failed');
    assert.match(run.steps[0].error!, /Cannot resolve/);

    await ctx.manager.disposeAll();
  });
});

// ---------------------------------------------------------------------------

describe('recorder', () => {
  it('captures invocations and converts them to tests', async () => {
    const ctx = await connected();
    const recorder = new Recorder(ctx.execution);

    recorder.start();
    await ctx.execution.callTool('demo', 'add', { a: 1, b: 2 });
    await ctx.execution.callTool('demo', 'echo', { message: 'hi' });
    recorder.stop();

    assert.equal(recorder.recorded.length, 2);

    const tests = recorder.toTests();
    assert.equal(tests.length, 2);
    // Shape assertions, not exact values, so a timestamp cannot break the suite.
    assert.ok(tests[0].assertions?.some((a) => a.path === '$.structuredContent.sum' && a.type === 'number'));

    await ctx.manager.disposeAll();
  });

  it('ignores calls to other servers when filtered', async () => {
    const ctx = await connected();
    const recorder = new Recorder(ctx.execution);

    recorder.start({ serverId: 'other' });
    await ctx.execution.callTool('demo', 'echo', { message: 'hi' });
    recorder.stop();

    assert.equal(recorder.recorded.length, 0);

    await ctx.manager.disposeAll();
  });

  it('replays the recorded sequence in order', async () => {
    const ctx = await connected();
    const recorder = new Recorder(ctx.execution);

    recorder.start();
    await ctx.execution.callTool('demo', 'add', { a: 1, b: 1 });
    await ctx.execution.callTool('demo', 'add', { a: 2, b: 2 });
    recorder.stop();

    const replayed = await recorder.replayAll();
    assert.equal(replayed.length, 2);
    assert.deepEqual(
      (replayed[0].output as { structuredContent: unknown }).structuredContent,
      { sum: 2 },
    );
    assert.deepEqual(
      (replayed[1].output as { structuredContent: unknown }).structuredContent,
      { sum: 4 },
    );

    await ctx.manager.disposeAll();
  });
});

describe('workflowFromHistory', () => {
  it('wires a later input to an earlier output when the value matches', () => {
    const entries: HistoryEntry[] = [
      {
        id: '1',
        timestamp: 1,
        serverId: 's',
        serverName: 'S',
        kind: 'tool',
        name: 'getUser',
        input: { email: 'sam@example.com' },
        output: { structuredContent: { id: 'u-42' } },
        durationMs: 1,
      },
      {
        id: '2',
        timestamp: 2,
        serverId: 's',
        serverName: 'S',
        kind: 'tool',
        name: 'getEntitlement',
        input: { userId: 'u-42' },
        output: { structuredContent: { plan: 'pro' } },
        durationMs: 1,
      },
    ];

    const workflow = workflowFromHistory(entries, 'Recorded');
    const second = workflow.steps[1];
    assert.deepEqual(second.input, {
      userId: '{{steps.getUser_1.output.structuredContent.id}}',
    });
    assert.deepEqual(validateWorkflow(workflow), []);
  });

  it('leaves unrelated literals alone', () => {
    const entries: HistoryEntry[] = [
      {
        id: '1',
        timestamp: 1,
        serverId: 's',
        serverName: 'S',
        kind: 'tool',
        name: 'a',
        input: {},
        output: { structuredContent: { id: 'x' } },
        durationMs: 1,
      },
      {
        id: '2',
        timestamp: 2,
        serverId: 's',
        serverName: 'S',
        kind: 'tool',
        name: 'b',
        input: { unrelated: 'literal' },
        durationMs: 1,
      },
    ];
    assert.deepEqual(workflowFromHistory(entries, 'r').steps[1].input, { unrelated: 'literal' });
  });
});

// ---------------------------------------------------------------------------

describe('workflow graph', () => {
  const flow = (steps: Workflow['steps']): Workflow => ({ id: 'w', name: 'W', steps });

  it('falls through in declaration order when nothing says otherwise', () => {
    const graph = buildWorkflowGraph(
      flow([
        { id: 'a', kind: 'tool', tool: 't' },
        { id: 'b', kind: 'tool', tool: 't' },
        { id: 'c', kind: 'tool', tool: 't' },
      ]),
    );
    assert.deepEqual(graph.edges, [
      { from: 'a', to: 'b', label: 'then' },
      { from: 'b', to: 'c', label: 'then' },
    ]);
  });

  it('lets an explicit next win over declaration order', () => {
    const graph = buildWorkflowGraph(
      flow([
        { id: 'a', kind: 'tool', tool: 't', next: 'c' },
        { id: 'b', kind: 'tool', tool: 't' },
        { id: 'c', kind: 'tool', tool: 't' },
      ]),
    );
    assert.deepEqual(graph.edges[0], { from: 'a', to: 'c', label: 'next' });
    assert.deepEqual(graph.unreachable, ['b']);
  });

  it('ends an arm that stops pointing forward, rather than running into the other', () => {
    // This is the rule the runner applies through its `branched` flag, and the
    // one a hand-drawn diagram would get wrong.
    const graph = buildWorkflowGraph(
      flow([
        { id: 'check', kind: 'branch', onTrue: 'yes', onFalse: 'no' },
        { id: 'yes', kind: 'tool', tool: 't' },
        { id: 'no', kind: 'tool', tool: 't' },
      ]),
    );
    assert.deepEqual(graph.edges, [
      { from: 'check', to: 'yes', label: 'true' },
      { from: 'check', to: 'no', label: 'false' },
    ]);
    // 'yes' must not fall through into 'no'.
    assert.equal(graph.edges.some((edge) => edge.from === 'yes'), false);
  });

  it('still falls through for steps before the first branch', () => {
    const graph = buildWorkflowGraph(
      flow([
        { id: 'setup', kind: 'tool', tool: 't' },
        { id: 'check', kind: 'branch', onTrue: 'yes' },
        { id: 'yes', kind: 'tool', tool: 't' },
      ]),
    );
    assert.deepEqual(graph.edges[0], { from: 'setup', to: 'check', label: 'then' });
  });

  it('reports a target that does not exist instead of drawing it', () => {
    const graph = buildWorkflowGraph(
      flow([{ id: 'a', kind: 'tool', tool: 't', next: 'typo' }]),
    );
    assert.deepEqual(graph.edges, []);
    assert.deepEqual(graph.dangling, ['typo']);
  });

  it('does not call the first step unreachable', () => {
    const graph = buildWorkflowGraph(flow([{ id: 'only', kind: 'tool', tool: 't' }]));
    assert.deepEqual(graph.unreachable, []);
  });
});

describe('catalog diff', () => {
  it('says nothing the first time it sees a server', () => {
    // Otherwise every server would light up as entirely new the moment it was
    // first drawn, and people would learn to ignore the highlight.
    assert.deepEqual(diffCatalogKeys(undefined, ['tool:a', 'tool:b']), {
      added: [],
      removed: [],
    });
  });

  it('reports what a list_changed notification actually changed', () => {
    const before = ['tool:a', 'tool:b', 'prompt:p'];
    const after = ['tool:a', 'tool:c', 'prompt:p', 'resource:r'];
    assert.deepEqual(diffCatalogKeys(before, after), {
      added: ['tool:c', 'resource:r'],
      removed: ['tool:b'],
    });
  });

  it('reports nothing when the catalog is unchanged', () => {
    const keys = ['tool:a', 'tool:b'];
    assert.deepEqual(diffCatalogKeys(keys, [...keys]), { added: [], removed: [] });
  });

  it('is not fooled by reordering', () => {
    assert.deepEqual(diffCatalogKeys(['a', 'b', 'c'], ['c', 'a', 'b']), {
      added: [],
      removed: [],
    });
  });

  it('treats an emptied catalog as a removal, not a first sighting', () => {
    assert.deepEqual(diffCatalogKeys(['tool:a'], []), { added: [], removed: ['tool:a'] });
  });
});

describe('catalog', () => {
  const tools: Tool[] = [
    { name: 'getDeploymentStatus', description: 'Checks a deployment.', inputSchema: {}, annotations: { readOnlyHint: true } },
    { name: 'rollbackDeployment', description: 'Rolls back.', inputSchema: {}, annotations: { destructiveHint: true } },
    { name: 'getUser', description: 'Fetches a user profile.', inputSchema: {} },
  ];

  const base = {
    config: { id: 'dep', name: 'Deployment MCP', transport: 'stdio' as const, metadata: { team: 'DevOps' } },
    status: 'connected' as const,
    target: 'node server.js',
    tools,
    resources: [],
    prompts: [],
  };

  it('counts tools by risk and reports healthy', () => {
    const entry = buildCatalogEntry(base);
    assert.equal(entry.health, 'healthy');
    assert.equal(entry.risk.read, 2);
    assert.equal(entry.risk.destructive, 1);
  });

  it('calls a connected but failing server degraded', () => {
    const entry = buildCatalogEntry({
      ...base,
      stats: {
        total: 10,
        succeeded: 7,
        failed: 3,
        averageMs: 100,
        p50Ms: 90,
        p95Ms: 120,
        byTarget: [],
      },
    });
    assert.equal(entry.health, 'degraded');
    assert.match(entry.healthDetail!, /30.0% of calls failed/);
  });

  it('calls an errored server unreachable', () => {
    const entry = buildCatalogEntry({ ...base, status: 'error', lastError: 'ECONNREFUSED' });
    assert.equal(entry.health, 'unreachable');
    assert.equal(entry.healthDetail, 'ECONNREFUSED');
  });
});

describe('search', () => {
  const sources = [
    {
      serverId: 'dep',
      serverName: 'Deployment MCP',
      metadata: { team: 'DevOps' },
      tools: [
        { name: 'getDeploymentStatus', description: 'Checks whether a deployment is healthy.', inputSchema: {} },
        { name: 'rollbackDeployment', description: 'Rolls a deployment back.', inputSchema: {} },
      ],
      resources: [],
      prompts: [],
    },
    {
      serverId: 'cms',
      serverName: 'CMS MCP',
      tools: [{ name: 'getEvents', description: 'Lists events.', inputSchema: {} }],
      resources: [],
      prompts: [],
    },
  ];

  it('ranks an exact name match first', () => {
    const hits = searchCatalog(sources, 'getEvents');
    assert.equal(hits[0].name, 'getEvents');
    assert.equal(hits[0].score, 100);
  });

  it('requires every term of a multi-word query', () => {
    const hits = searchCatalog(sources, 'deployment healthy');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].name, 'getDeploymentStatus');
  });

  it('spans every server', () => {
    const hits = searchCatalog(sources, 'get');
    const servers = new Set(hits.map((h) => h.serverName));
    assert.ok(servers.has('Deployment MCP'));
    assert.ok(servers.has('CMS MCP'));
  });

  it('matches a server by its team', () => {
    const hits = searchCatalog(sources, 'devops');
    assert.equal(hits[0].kind, 'server');
  });

  it('returns nothing for an empty query', () => {
    assert.deepEqual(searchCatalog(sources, '   '), []);
  });
});
