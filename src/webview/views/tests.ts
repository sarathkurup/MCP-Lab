import type { SuiteResult, TestAssertion, TestResult, TestSuite } from '../../core/testing';
import type { AppContext, ViewDefinition } from '../app';
import { codeBlock, formatDuration, h, pretty } from '../dom';
import { emptyState } from './explorer';

interface TestScratch {
  suites: TestSuite[];
  results: Map<string, TestResult>;
  running: boolean;
  selected?: string;
  summaryEl?: HTMLElement;
}

function key(suiteName: string, testName: string): string {
  return `${suiteName}::${testName}`;
}

function scratch(ctx: AppContext): TestScratch {
  const existing = ctx.state.scratch.tests as TestScratch | undefined;
  if (existing) {
    return existing;
  }
  const created: TestScratch = { suites: [], results: new Map(), running: false };
  ctx.state.scratch.tests = created;
  return created;
}

export const testsView: ViewDefinition = {
  id: 'tests',
  label: 'Tests',
  glyph: '🧪',

  async render(ctx) {
    const store = scratch(ctx);
    store.suites = await ctx.rpc.call<TestSuite[]>('tests');

    if (store.suites.length === 0) {
      return emptyState(
        'No MCP test suites found.',
        'Suites are plain JSON files matching **/*.mcp-test.json, so they run in CI without MCPilot. Generate a starter suite from any tool.',
        h(
          'button',
          {
            class: 'btn-primary',
            onClick: () =>
              void ctx.rpc.call('generateTests', { serverId: ctx.state.serverId, toolName: '' }),
          },
          'Generate tests from a tool',
        ),
      );
    }

    const list = h('div', { class: 'catalog-rows' });
    for (const suite of store.suites) {
      list.appendChild(suiteBlock(ctx, store, suite));
    }

    const summary = h('div', { class: 'test-summary' });
    store.summaryEl = summary;
    renderSummary(store);

    const detail = h('div', { class: 'detail' });
    const selected = store.selected ? store.results.get(store.selected) : undefined;
    detail.appendChild(
      selected
        ? renderResultDetail(selected)
        : emptyState('Select a test', 'Run a suite to see assertions, timing and the response.'),
    );

    return h(
      'div',
      { class: 'split' },
      h(
        'aside',
        { class: 'catalog' },
        h(
          'div',
          { class: 'catalog-search' },
          h(
            'button',
            {
              class: 'btn-primary',
              disabled: store.running,
              onClick: () => void runAll(ctx, store),
            },
            store.running ? 'Running…' : '▶ Run all',
          ),
        ),
        summary,
        list,
      ),
      h('section', { class: 'detail' }, detail),
    );
  },

  onEvent(ctx, name, payload) {
    if (name === 'test-result') {
      const store = scratch(ctx);
      const result = payload as TestResult;
      store.results.set(key(result.suiteName, result.test.name), result);
      paintRow(result);
      renderSummary(store);
      return;
    }
    if (name === 'tests-changed') {
      void ctx.refresh();
    }
  },
};

async function runAll(ctx: AppContext, store: TestScratch): Promise<void> {
  store.running = true;
  store.results.clear();
  ctx.refresh();
  try {
    const suiteResults = await ctx.rpc.call<SuiteResult[]>('runTests', {
      serverId: ctx.state.serverId,
    });
    for (const suite of suiteResults) {
      for (const result of suite.results) {
        store.results.set(key(result.suiteName, result.test.name), result);
      }
    }
  } catch (err) {
    ctx.toast((err as Error).message, 'error');
  } finally {
    store.running = false;
    ctx.refresh();
  }
}

function suiteBlock(ctx: AppContext, store: TestScratch, suite: TestSuite): HTMLElement {
  const rows = suite.tests.map((test) => {
    const id = key(suite.name, test.name);
    const result = store.results.get(id);
    const row = h(
      'button',
      {
        class: `catalog-row test-row${store.selected === id ? ' selected' : ''}`,
        onClick: () => {
          store.selected = id;
          ctx.refresh();
        },
      },
      h(
        'div',
        { class: 'catalog-row-head' },
        h('span', { class: 'test-status' }, statusGlyph(result?.status)),
        h('span', { class: 'catalog-name' }, test.name),
        result ? h('span', { class: 'muted small' }, formatDuration(result.durationMs)) : null,
      ),
      h(
        'span',
        { class: 'catalog-desc' },
        `${test.tool ?? test.resource ?? test.prompt}${test.expectError ? ' · expects failure' : ''}`,
      ),
    );
    row.dataset.testId = id;
    return row;
  });

  return h(
    'div',
    { class: 'catalog-section' },
    h(
      'h3',
      null,
      suite.name,
      h(
        'span',
        { class: 'count' },
        suite.sourceUri
          ? h(
              'button',
              {
                class: 'btn-ghost',
                onClick: (event: MouseEvent) => {
                  event.stopPropagation();
                  void ctx.rpc.call('openTestFile', { sourceUri: suite.sourceUri });
                },
              },
              'Open',
            )
          : String(suite.tests.length),
      ),
    ),
    ...rows,
  );
}

function paintRow(result: TestResult): void {
  const id = key(result.suiteName, result.test.name);
  const row = document.querySelector(`[data-test-id="${id.replace(/"/g, '\\"')}"]`);
  const glyph = row?.querySelector('.test-status');
  if (glyph) {
    glyph.textContent = statusGlyph(result.status);
  }
}

function renderSummary(store: TestScratch): void {
  const host = store.summaryEl;
  if (!host) {
    return;
  }
  const results = [...store.results.values()];
  const passed = results.filter((r) => r.status === 'passed').length;
  const failed = results.filter((r) => r.status === 'failed' || r.status === 'errored').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;

  host.replaceChildren(
    h(
      'div',
      { class: 'summary-row' },
      h('span', { class: 'badge badge-ok' }, `${passed} passed`),
      failed ? h('span', { class: 'badge badge-destructive' }, `${failed} failed`) : null,
      skipped ? h('span', { class: 'badge' }, `${skipped} skipped`) : null,
    ),
  );
}

function renderResultDetail(result: TestResult): HTMLElement {
  const container = h(
    'div',
    { class: 'tool-detail' },
    h(
      'header',
      { class: 'detail-head' },
      h('h2', null, result.test.name),
      h(
        'span',
        {
          class: `badge ${
            result.status === 'passed'
              ? 'badge-ok'
              : result.status === 'skipped'
                ? ''
                : 'badge-destructive'
          }`,
        },
        result.status,
      ),
      h('span', { class: 'muted' }, formatDuration(result.durationMs)),
    ),
  );

  if (result.message) {
    container.appendChild(
      h('div', { class: 'error-box' }, h('div', { class: 'error-title' }, result.message)),
    );
  }

  if (result.assertions.length) {
    const table = h('div', { class: 'assertions' });
    for (const assertion of result.assertions) {
      table.appendChild(
        h(
          'div',
          { class: `assertion${assertion.passed ? '' : ' failed'}` },
          h('span', { class: 'test-status' }, assertion.passed ? '✔' : '✘'),
          h('code', null, assertion.assertion.path),
          h('span', { class: 'muted small' }, describeAssertion(assertion.assertion)),
          assertion.passed
            ? null
            : h('span', { class: 'assertion-actual' }, `actual: ${pretty(assertion.actual)}`),
        ),
      );
    }
    container.appendChild(
      h('div', { class: 'section' }, h('h3', null, 'Assertions'), table),
    );
  }

  container.appendChild(
    h(
      'details',
      { class: 'collapsible' },
      h('summary', null, 'Request'),
      codeBlock(pretty(result.test.input)),
    ),
  );

  if (result.entry) {
    container.appendChild(
      h(
        'details',
        { class: 'collapsible' },
        h('summary', null, 'Response'),
        codeBlock(pretty(result.entry.error ?? result.entry.output)),
      ),
    );
  }

  return container;
}

function describeAssertion(assertion: TestAssertion): string {
  const conditions = [
    'equals',
    'notEquals',
    'contains',
    'matches',
    'type',
    'exists',
    'lessThan',
    'greaterThan',
  ] as const;
  for (const key of conditions) {
    const value = assertion[key];
    if (value !== undefined) {
      return `${key} ${JSON.stringify(value)}`;
    }
  }
  return '';
}

function statusGlyph(status?: TestResult['status']): string {
  switch (status) {
    case 'passed':
      return '✔';
    case 'failed':
      return '✘';
    case 'errored':
      return '!';
    case 'skipped':
      return '–';
    default:
      return '·';
  }
}
