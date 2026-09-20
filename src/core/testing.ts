import type { ExecutionService } from './execution';
import type { HistoryEntry } from './history';

/**
 * A declarative MCP test: call a tool, assert on what comes back. Kept as data
 * rather than code so tests can be generated, recorded, diffed and run in CI.
 */

export interface TestAssertion {
  /** JSONPath-lite against the result, e.g. `$.structuredContent.sum`. */
  path: string;
  equals?: unknown;
  notEquals?: unknown;
  contains?: string;
  matches?: string;
  exists?: boolean;
  type?: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null';
  lessThan?: number;
  greaterThan?: number;
}

export interface TestCase {
  name: string;
  /** Overrides the suite's server; usually left unset. */
  server?: string;
  tool?: string;
  resource?: string;
  prompt?: string;
  input?: unknown;
  /** Expect the call itself to fail, optionally with a specific code/message. */
  expectError?: boolean | { code?: number; message?: string };
  /** Expect the server to reply with `isError: true`. */
  expectToolError?: boolean;
  assertions?: TestAssertion[];
  maxDurationMs?: number;
  /** Skip without deleting, e.g. while a server-side fix is pending. */
  skip?: boolean;
}

export interface TestSuite {
  name: string;
  /** Server name or id these tests target. */
  server?: string;
  tests: TestCase[];
  /** Where the suite came from, for reporting. */
  sourceUri?: string;
}

export interface AssertionResult {
  assertion: TestAssertion;
  passed: boolean;
  actual?: unknown;
  message?: string;
}

export interface TestResult {
  test: TestCase;
  suiteName: string;
  status: 'passed' | 'failed' | 'skipped' | 'errored';
  durationMs: number;
  message?: string;
  assertions: AssertionResult[];
  entry?: HistoryEntry;
}

export interface SuiteResult {
  suite: TestSuite;
  results: TestResult[];
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

/** Accepts a single test object, an array, or a `{ tests: [...] }` suite. */
export function parseSuite(raw: unknown, name: string, sourceUri?: string): TestSuite {
  if (Array.isArray(raw)) {
    return { name, tests: raw.map(normalizeCase), sourceUri };
  }
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    if (Array.isArray(record.tests)) {
      return {
        name: typeof record.name === 'string' ? record.name : name,
        server: typeof record.server === 'string' ? record.server : undefined,
        tests: record.tests.map(normalizeCase),
        sourceUri,
      };
    }
    // A bare test object, which is the shape the docs show first.
    return { name, tests: [normalizeCase(record)], sourceUri };
  }
  throw new Error(`"${name}" is not a valid MCP test file`);
}

function normalizeCase(raw: unknown, index = 0): TestCase {
  const record = (raw ?? {}) as Record<string, unknown>;
  const target =
    (record.tool as string) ?? (record.resource as string) ?? (record.prompt as string);
  if (!target) {
    throw new Error('Each test needs a "tool", "resource" or "prompt"');
  }
  return {
    name: (record.name as string) ?? `${target} #${index + 1}`,
    server: record.server as string | undefined,
    tool: record.tool as string | undefined,
    resource: record.resource as string | undefined,
    prompt: record.prompt as string | undefined,
    input: record.input ?? record.arguments ?? {},
    expectError: record.expectError as TestCase['expectError'],
    expectToolError: record.expectToolError as boolean | undefined,
    assertions: (record.assertions as TestAssertion[]) ?? [],
    maxDurationMs: record.maxDurationMs as number | undefined,
    skip: record.skip as boolean | undefined,
  };
}

export class TestRunner {
  constructor(private readonly execution: ExecutionService) {}

  async runSuite(
    suite: TestSuite,
    serverId: string,
    options: { onResult?: (result: TestResult) => void; signal?: { aborted: boolean } } = {},
  ): Promise<SuiteResult> {
    const started = Date.now();
    const results: TestResult[] = [];

    for (const test of suite.tests) {
      if (options.signal?.aborted) {
        break;
      }
      const result = await this.runCase(test, suite.name, serverId);
      results.push(result);
      options.onResult?.(result);
    }

    return {
      suite,
      results,
      passed: results.filter((r) => r.status === 'passed').length,
      failed: results.filter((r) => r.status === 'failed' || r.status === 'errored').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      durationMs: Date.now() - started,
    };
  }

  async runCase(test: TestCase, suiteName: string, serverId: string): Promise<TestResult> {
    if (test.skip) {
      return { test, suiteName, status: 'skipped', durationMs: 0, assertions: [] };
    }

    const started = Date.now();
    try {
      const outcome = await this.invoke(test, serverId);
      const entry = outcome.entry;
      const durationMs = Date.now() - started;

      // Expected-failure tests assert on the error rather than the payload.
      if (test.expectError) {
        if (!entry.error) {
          return fail(test, suiteName, durationMs, 'Expected the call to fail, but it succeeded', entry);
        }
        const expectation = typeof test.expectError === 'object' ? test.expectError : {};
        if (expectation.code !== undefined && entry.error.code !== expectation.code) {
          return fail(
            test,
            suiteName,
            durationMs,
            `Expected error code ${expectation.code}, got ${entry.error.code}`,
            entry,
          );
        }
        if (expectation.message && !entry.error.message.includes(expectation.message)) {
          return fail(
            test,
            suiteName,
            durationMs,
            `Expected error message to contain "${expectation.message}", got "${entry.error.message}"`,
            entry,
          );
        }
        return { test, suiteName, status: 'passed', durationMs, assertions: [], entry };
      }

      if (entry.error) {
        return fail(test, suiteName, durationMs, entry.error.message, entry);
      }

      if (test.expectToolError !== undefined && !!entry.toolError !== test.expectToolError) {
        return fail(
          test,
          suiteName,
          durationMs,
          `Expected isError to be ${test.expectToolError}, got ${!!entry.toolError}`,
          entry,
        );
      }

      if (test.maxDurationMs !== undefined && entry.durationMs > test.maxDurationMs) {
        return fail(
          test,
          suiteName,
          durationMs,
          `Took ${entry.durationMs}ms, budget is ${test.maxDurationMs}ms`,
          entry,
        );
      }

      const assertions = (test.assertions ?? []).map((assertion) =>
        evaluate(assertion, entry.output),
      );
      const failed = assertions.filter((a) => !a.passed);

      return {
        test,
        suiteName,
        status: failed.length === 0 ? 'passed' : 'failed',
        durationMs,
        message: failed.length ? failed.map((f) => f.message).join('; ') : undefined,
        assertions,
        entry,
      };
    } catch (err) {
      // A thrown error is a problem with the test itself (unknown tool, server
      // not connected), which is distinct from a failing assertion.
      return {
        test,
        suiteName,
        status: 'errored',
        durationMs: Date.now() - started,
        message: err instanceof Error ? err.message : String(err),
        assertions: [],
      };
    }
  }

  private async invoke(test: TestCase, serverId: string) {
    if (test.tool) {
      return this.execution.callTool(serverId, test.tool, test.input, {
        // Tests deliberately send malformed payloads, so the server decides.
        skipValidation: true,
        prune: false,
      });
    }
    if (test.resource) {
      return this.execution.readResource(serverId, test.resource);
    }
    return this.execution.getPrompt(
      serverId,
      test.prompt!,
      (test.input ?? {}) as Record<string, string>,
    );
  }
}

function fail(
  test: TestCase,
  suiteName: string,
  durationMs: number,
  message: string,
  entry?: HistoryEntry,
): TestResult {
  return { test, suiteName, status: 'failed', durationMs, message, assertions: [], entry };
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

export function evaluate(assertion: TestAssertion, output: unknown): AssertionResult {
  const actual = resolvePath(output, assertion.path);
  const describe = (expected: string) =>
    `${assertion.path}: expected ${expected}, got ${JSON.stringify(actual)}`;

  if (assertion.exists !== undefined) {
    const exists = actual !== undefined;
    return result(exists === assertion.exists, assertion, actual, describe(assertion.exists ? 'it to exist' : 'it to be absent'));
  }

  if (assertion.equals !== undefined) {
    const passed = JSON.stringify(actual) === JSON.stringify(assertion.equals);
    return result(passed, assertion, actual, describe(JSON.stringify(assertion.equals)));
  }

  if (assertion.notEquals !== undefined) {
    const passed = JSON.stringify(actual) !== JSON.stringify(assertion.notEquals);
    return result(passed, assertion, actual, describe(`anything but ${JSON.stringify(assertion.notEquals)}`));
  }

  if (assertion.contains !== undefined) {
    const haystack = typeof actual === 'string' ? actual : JSON.stringify(actual ?? '');
    return result(haystack.includes(assertion.contains), assertion, actual, describe(`to contain "${assertion.contains}"`));
  }

  if (assertion.matches !== undefined) {
    const haystack = typeof actual === 'string' ? actual : JSON.stringify(actual ?? '');
    let passed = false;
    try {
      passed = new RegExp(assertion.matches).test(haystack);
    } catch {
      return result(false, assertion, actual, `${assertion.path}: "${assertion.matches}" is not a valid regular expression`);
    }
    return result(passed, assertion, actual, describe(`to match /${assertion.matches}/`));
  }

  if (assertion.type !== undefined) {
    return result(typeOf(actual) === assertion.type, assertion, actual, describe(`type ${assertion.type}`));
  }

  if (assertion.lessThan !== undefined) {
    return result(
      typeof actual === 'number' && actual < assertion.lessThan,
      assertion,
      actual,
      describe(`< ${assertion.lessThan}`),
    );
  }

  if (assertion.greaterThan !== undefined) {
    return result(
      typeof actual === 'number' && actual > assertion.greaterThan,
      assertion,
      actual,
      describe(`> ${assertion.greaterThan}`),
    );
  }

  return result(false, assertion, actual, `${assertion.path}: assertion has no condition`);
}

function result(
  passed: boolean,
  assertion: TestAssertion,
  actual: unknown,
  message: string,
): AssertionResult {
  return { assertion, passed, actual, message: passed ? undefined : message };
}

function typeOf(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

/**
 * JSONPath-lite: `$.a.b[0].c`. Enough for assertions without pulling in a
 * full JSONPath implementation, and predictable enough to generate.
 */
export function resolvePath(root: unknown, path: string): unknown {
  if (!path || path === '$') {
    return root;
  }
  const cleaned = path.startsWith('$') ? path.slice(1) : path;
  const segments = cleaned
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((s) => s.length > 0);

  let cursor: unknown = root;
  for (const segment of segments) {
    if (cursor === null || cursor === undefined) {
      return undefined;
    }
    if (Array.isArray(cursor)) {
      const index = Number(segment);
      if (Number.isNaN(index)) {
        return undefined;
      }
      cursor = cursor[index];
      continue;
    }
    if (typeof cursor === 'object') {
      cursor = (cursor as Record<string, unknown>)[segment];
      continue;
    }
    return undefined;
  }
  return cursor;
}
