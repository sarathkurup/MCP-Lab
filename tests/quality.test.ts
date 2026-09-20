import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ConnectionManager } from '../src/core/ConnectionManager';
import { diagnose } from '../src/core/doctor';
import {
  DEFAULT_ENVIRONMENTS,
  classifyTool,
  guard,
  resolveForEnvironment,
} from '../src/core/environments';
import { ExecutionService } from '../src/core/execution';
import { HistoryStore } from '../src/core/history';
import { lint, summarize } from '../src/core/linter';
import { LogStore } from '../src/core/logging';
import type { Tool } from '../src/core/protocol';
import { evaluate, parseSuite, resolvePath, TestRunner } from '../src/core/testing';
import { generateTests } from '../src/core/testgen';
import { TraceStore } from '../src/core/trace';

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
  return manager;
}

// ---------------------------------------------------------------------------

describe('resolvePath', () => {
  const doc = {
    content: [{ type: 'text', text: 'hello' }],
    structuredContent: { sum: 42, nested: { list: [1, 2, 3] } },
    isError: false,
  };

  it('walks objects, arrays and the $ root', () => {
    assert.equal(resolvePath(doc, '$.content[0].text'), 'hello');
    assert.equal(resolvePath(doc, '$.structuredContent.sum'), 42);
    assert.equal(resolvePath(doc, '$.structuredContent.nested.list[2]'), 3);
    assert.equal(resolvePath(doc, '$.isError'), false);
    assert.deepEqual(resolvePath(doc, '$'), doc);
  });

  it('returns undefined rather than throwing on a bad path', () => {
    assert.equal(resolvePath(doc, '$.nope.deeper'), undefined);
    assert.equal(resolvePath(doc, '$.content[9].text'), undefined);
    assert.equal(resolvePath(doc, '$.content.text'), undefined);
  });
});

describe('assertions', () => {
  const output = { content: [{ type: 'text', text: 'Deleted evt-1' }], structuredContent: { count: 3 } };

  it('supports every condition', () => {
    assert.equal(evaluate({ path: '$.structuredContent.count', equals: 3 }, output).passed, true);
    assert.equal(evaluate({ path: '$.structuredContent.count', equals: 4 }, output).passed, false);
    assert.equal(evaluate({ path: '$.structuredContent.count', notEquals: 4 }, output).passed, true);
    assert.equal(evaluate({ path: '$.content[0].text', contains: 'Deleted' }, output).passed, true);
    assert.equal(evaluate({ path: '$.content[0].text', matches: '^Deleted \\w+' }, output).passed, true);
    assert.equal(evaluate({ path: '$.content', type: 'array' }, output).passed, true);
    assert.equal(evaluate({ path: '$.isError', exists: false }, output).passed, true);
    assert.equal(evaluate({ path: '$.structuredContent.count', lessThan: 5 }, output).passed, true);
    assert.equal(evaluate({ path: '$.structuredContent.count', greaterThan: 5 }, output).passed, false);
  });

  it('reports the actual value on failure', () => {
    const result = evaluate({ path: '$.structuredContent.count', equals: 99 }, output);
    assert.equal(result.passed, false);
    assert.equal(result.actual, 3);
    assert.match(result.message!, /expected 99, got 3/);
  });

  it('fails cleanly on an invalid regular expression', () => {
    const result = evaluate({ path: '$.content[0].text', matches: '([' }, output);
    assert.equal(result.passed, false);
    assert.match(result.message!, /not a valid regular expression/);
  });
});

describe('parseSuite', () => {
  it('accepts a bare test object', () => {
    const suite = parseSuite({ tool: 'getEvents', input: { environment: 'QC' } }, 'get-events');
    assert.equal(suite.tests.length, 1);
    assert.equal(suite.tests[0].tool, 'getEvents');
  });

  it('accepts an array and a full suite', () => {
    assert.equal(parseSuite([{ tool: 'a' }, { tool: 'b' }], 'x').tests.length, 2);
    const full = parseSuite({ name: 'CMS', server: 'CMS MCP', tests: [{ tool: 'a' }] }, 'x');
    assert.equal(full.name, 'CMS');
    assert.equal(full.server, 'CMS MCP');
  });

  it('rejects a test with no target', () => {
    assert.throws(() => parseSuite({ input: {} }, 'x'), /tool/);
  });
});

describe('TestRunner', () => {
  it('passes, fails and reports assertions against a live server', async () => {
    const manager = await connected();
    const execution = new ExecutionService(manager, new HistoryStore());
    const runner = new TestRunner(execution);

    const result = await runner.runSuite(
      {
        name: 'demo',
        tests: [
          {
            name: 'echo works',
            tool: 'echo',
            input: { message: 'hi' },
            assertions: [{ path: '$.content[0].text', equals: 'hi' }],
          },
          {
            name: 'add returns structured output',
            tool: 'add',
            input: { a: 2, b: 3 },
            assertions: [{ path: '$.structuredContent.sum', equals: 5 }],
          },
          {
            name: 'wrong expectation',
            tool: 'echo',
            input: { message: 'hi' },
            assertions: [{ path: '$.content[0].text', equals: 'bye' }],
          },
          {
            name: 'missing message is rejected',
            tool: 'echo',
            input: {},
            expectError: true,
          },
          { name: 'skipped', tool: 'echo', input: { message: 'x' }, skip: true },
        ],
      },
      'demo',
    );

    assert.equal(result.passed, 3);
    assert.equal(result.failed, 1);
    assert.equal(result.skipped, 1);

    const failure = result.results.find((r) => r.test.name === 'wrong expectation')!;
    assert.equal(failure.status, 'failed');
    assert.equal(failure.assertions[0].actual, 'hi');

    await manager.disposeAll();
  });

  it('fails an expectError test when the call succeeds', async () => {
    const manager = await connected();
    const runner = new TestRunner(new ExecutionService(manager, new HistoryStore()));

    const result = await runner.runCase(
      { name: 'wrongly expects failure', tool: 'echo', input: { message: 'ok' }, expectError: true },
      'demo',
      'demo',
    );
    assert.equal(result.status, 'failed');
    assert.match(result.message!, /Expected the call to fail/);

    await manager.disposeAll();
  });

  it('enforces a duration budget', async () => {
    const manager = await connected();
    const runner = new TestRunner(new ExecutionService(manager, new HistoryStore()));

    // slowQuery sleeps, so the budget check is deterministic rather than
    // depending on how fast the machine answers an echo.
    const result = await runner.runCase(
      { name: 'too slow', tool: 'slowQuery', input: { delayMs: 60 }, maxDurationMs: 10 },
      'demo',
      'demo',
    );
    assert.equal(result.status, 'failed');
    assert.match(result.message!, /budget/);

    await manager.disposeAll();
  });

  it('errors (not fails) when the test itself is wrong', async () => {
    const manager = await connected();
    const runner = new TestRunner(new ExecutionService(manager, new HistoryStore()));

    const result = await runner.runCase(
      { name: 'ghost tool', tool: 'ghost', input: {} },
      'demo',
      'demo',
    );
    assert.equal(result.status, 'errored');

    await manager.disposeAll();
  });
});

// ---------------------------------------------------------------------------

describe('linter', () => {
  const tools: Tool[] = [
    {
      name: 'deleteEvent',
      description: 'Deletes an event permanently.',
      inputSchema: { type: 'object', properties: { eventId: { type: 'string' } }, required: ['eventId'] },
    },
    {
      name: 'x',
      inputSchema: { type: 'object', properties: { apiKey: { type: 'string' }, thing: {} } },
    },
    {
      name: 'readOnlyButDestructive',
      description: 'A contradictory tool used to exercise the annotation rule.',
      inputSchema: { type: 'object', properties: {}, required: [] },
      annotations: { readOnlyHint: true, destructiveHint: true },
    },
  ];

  const findings = lint({ tools, resources: [], prompts: [] });
  const rules = new Set(findings.map((f) => f.rule));

  it('flags a destructive-looking tool with no annotation', () => {
    assert.ok(rules.has('MCP004'));
    const finding = findings.find((f) => f.rule === 'MCP004')!;
    assert.equal(finding.target.name, 'deleteEvent');
  });

  it('flags a missing description', () => {
    assert.ok(findings.some((f) => f.rule === 'MCP001' && f.target.name === 'x'));
  });

  it('flags a credential-shaped parameter', () => {
    const finding = findings.find((f) => f.rule === 'MCP005');
    assert.ok(finding);
    assert.match(finding!.message, /apiKey/);
  });

  it('flags an untyped property and a missing required list', () => {
    assert.ok(findings.some((f) => f.rule === 'MCP003' && /thing/.test(f.message)));
  });

  it('flags contradictory annotations', () => {
    assert.ok(rules.has('MCP009'));
  });

  it('reports coverage only when a test index is supplied', () => {
    const without = lint({ tools, resources: [], prompts: [] });
    assert.equal(without.filter((f) => f.rule === 'MCP007').length, 0);

    const covered = lint({
      tools,
      resources: [],
      prompts: [],
      testedTargets: new Set(['tool:deleteEvent']),
    });
    const untested = covered.filter((f) => f.rule === 'MCP007').map((f) => f.target.name);
    assert.deepEqual(untested.sort(), ['readOnlyButDestructive', 'x']);
  });

  it('summarises by severity', () => {
    const counts = summarize(findings);
    assert.ok(counts.errors > 0);
    assert.ok(counts.warnings > 0);
  });

  it('is quiet on a well-formed tool', () => {
    const clean = lint({
      tools: [
        {
          name: 'getEvents',
          description: 'Lists events for an environment, newest first.',
          inputSchema: {
            type: 'object',
            properties: { environment: { type: 'string', description: 'DEV, QC or PROD' } },
            required: ['environment'],
          },
          outputSchema: { type: 'object', properties: { events: { type: 'array' } } },
          annotations: { readOnlyHint: true },
        },
      ],
      resources: [],
      prompts: [],
    });
    assert.deepEqual(clean, []);
  });
});

// ---------------------------------------------------------------------------

describe('doctor', () => {
  it('reports a healthy server as healthy', async () => {
    const manager = await connected();
    const report = await diagnose(manager.get('demo')!, { probe: true });

    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    assert.equal(byId.connectivity.status, 'pass');
    assert.equal(byId.protocol.status, 'pass');
    assert.equal(byId.tools.status, 'pass');
    assert.equal(byId.errors.status, 'pass', 'unknown tool is rejected');
    assert.equal(byId.logging.status, 'pass');
    // The fixture annotates its destructive tool, so this check should be clean.
    assert.equal(byId.destructive.status, 'pass');
    // No test index was supplied, so coverage is skipped rather than guessed at.
    assert.equal(byId.coverage.status, 'skip');
    assert.ok(report.passed > 0);

    await manager.disposeAll();
  });

  it('stops early when the server is not connected', async () => {
    const manager = await connected();
    await manager.disconnect('demo');

    const report = await diagnose(manager.get('demo')!);
    assert.equal(report.checks.length, 1);
    assert.equal(report.checks[0].status, 'fail');

    await manager.disposeAll();
  });
});

// ---------------------------------------------------------------------------

describe('test generation', () => {
  const tool: Tool = {
    name: 'updateEvent',
    description: 'Updates an event.',
    inputSchema: {
      type: 'object',
      properties: {
        eventId: { type: 'string', minLength: 3 },
        priority: { type: 'integer', minimum: 1, maximum: 5 },
        environment: { type: 'string', enum: ['DEV', 'QC'] },
        startsAt: { type: 'string', format: 'date-time' },
      },
      required: ['eventId'],
    },
  };

  const cases = generateTests(tool);

  it('produces a happy path built from the schema', () => {
    const happy = cases.find((c) => c.name.includes('valid input'))!;
    const input = happy.input as Record<string, unknown>;
    assert.equal(input.eventId, 'test-eventId');
    assert.equal(input.priority, 1, 'minimum is used');
    assert.equal(input.environment, 'DEV', 'first enum value');
    assert.equal(input.startsAt, '2026-01-01T00:00:00Z', 'format-aware sample');
  });

  it('covers required, type, enum, bound and format violations', () => {
    const names = cases.map((c) => c.name).join('\n');
    assert.match(names, /missing required "eventId"/);
    assert.match(names, /"eventId" has the wrong type/);
    assert.match(names, /"environment" outside its enum/);
    assert.match(names, /"priority" below minimum/);
    assert.match(names, /"priority" above maximum/);
    assert.match(names, /"eventId" shorter than minLength/);
    assert.match(names, /"startsAt" is not a valid date-time/);
  });

  it('marks every negative case as expecting an error', () => {
    for (const testCase of cases.filter((c) => !c.name.includes('valid input'))) {
      if (testCase.name.includes('empty input')) {
        continue;
      }
      assert.equal(testCase.expectError, true, testCase.name);
    }
  });

  it('generated negative cases actually fail against a real server', async () => {
    const manager = await connected();
    const runner = new TestRunner(new ExecutionService(manager, new HistoryStore()));
    const echo: Tool = manager.get('demo')!.catalog.tools.find((t) => t.name === 'echo')!;

    const suite = { name: 'generated', tests: generateTests(echo) };
    const result = await runner.runSuite(suite, 'demo');

    // The whole point: a schema-derived suite should pass as-is against a
    // server that honours its own schema.
    assert.equal(result.failed, 0, JSON.stringify(result.results.filter((r) => r.status !== 'passed'), null, 2));

    await manager.disposeAll();
  });
});

// ---------------------------------------------------------------------------

describe('environments', () => {
  it('classifies tools by annotation first, then by name', () => {
    assert.equal(classifyTool({ name: 'anything', inputSchema: {}, annotations: { destructiveHint: true } }), 'destructive');
    assert.equal(classifyTool({ name: 'anything', inputSchema: {}, annotations: { readOnlyHint: true } }), 'read');
    assert.equal(classifyTool({ name: 'deleteEvent', inputSchema: {} }), 'destructive');
    assert.equal(classifyTool({ name: 'getEvents', inputSchema: {} }), 'read');
    assert.equal(classifyTool({ name: 'updateEvent', inputSchema: {} }), 'write');
  });

  it('gates writes in production and destructive calls everywhere', () => {
    assert.equal(guard('read', 'prod').confirm, false);
    assert.equal(guard('write', 'prod').confirm, true);
    assert.equal(guard('destructive', 'prod').severity, 'danger');
    assert.equal(guard('write', 'dev').confirm, false);
    assert.equal(guard('destructive', 'dev').confirm, true);
  });

  it('gates UAT writes, but says UAT rather than production', () => {
    // UAT sits between QC and PROD: a write stops, a read does not, and the
    // wording has to name the tier or the prompt teaches people to click through.
    assert.equal(guard('read', 'uat').confirm, false);
    assert.equal(guard('write', 'uat').confirm, true);
    assert.match(guard('write', 'uat').reason ?? '', /UAT/);
    assert.equal(guard('write', 'uat').severity, 'warning');
    assert.equal(guard('destructive', 'uat').severity, 'danger');
    assert.doesNotMatch(guard('write', 'uat').reason ?? '', /PRODUCTION/);

    // QC keeps the looser rule: only destructive calls stop.
    assert.equal(guard('write', 'qc').confirm, false);
  });

  it('ships UAT as a built-in environment', () => {
    const tiers = DEFAULT_ENVIRONMENTS.map((environment) => environment.tier);
    assert.deepEqual(tiers, ['dev', 'qc', 'uat', 'prod']);
  });

  it('merges per-environment overrides without mutating the base config', () => {
    const base = {
      id: 's',
      name: 'S',
      transport: 'http' as const,
      url: 'https://dev.example.com/mcp',
      headers: { 'x-base': '1' },
      environments: {
        prod: { url: 'https://prod.example.com/mcp', headers: { 'x-env': 'prod' } },
      },
    };

    const resolved = resolveForEnvironment(base, 'prod');
    assert.equal(resolved.url, 'https://prod.example.com/mcp');
    assert.deepEqual(resolved.headers, { 'x-base': '1', 'x-env': 'prod' });
    assert.equal(resolved.environmentId, 'prod');
    assert.equal(base.url, 'https://dev.example.com/mcp', 'base is untouched');

    assert.equal(resolveForEnvironment(base, 'qc').url, 'https://dev.example.com/mcp');
  });
});
