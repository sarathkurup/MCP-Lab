import type { CompareResult, ToolDiff } from '../../core/compare';
import type { AppContext, ViewDefinition } from '../app';
import { h } from '../dom';
import { emptyState } from './explorer';

interface CompareScratch {
  leftId?: string;
  rightId?: string;
  result?: CompareResult;
  running: boolean;
}

function scratch(ctx: AppContext): CompareScratch {
  const existing = ctx.state.scratch.compare as CompareScratch | undefined;
  if (existing) {
    return existing;
  }
  const created: CompareScratch = { running: false };
  ctx.state.scratch.compare = created;
  return created;
}

export const compareView: ViewDefinition = {
  id: 'compare',
  label: 'Compare',
  glyph: '⇄',

  async render(ctx) {
    const store = scratch(ctx);
    const servers = ctx.snapshot.servers;

    if (servers.length < 2) {
      return emptyState(
        'Comparison needs two servers.',
        'Add the same server twice - one per environment - to catch contract drift before it reaches production.',
      );
    }

    store.leftId ??= servers[0].id;
    store.rightId ??= servers[1].id;

    const picker = (side: 'leftId' | 'rightId') => {
      const select = h('select', {
        class: 'server-select',
        onChange: (event) => {
          store[side] = (event.target as HTMLSelectElement).value;
          store.result = undefined;
          ctx.refresh();
        },
      });
      for (const server of servers) {
        const option = h('option', { value: server.id }, server.name);
        option.selected = server.id === store[side];
        select.appendChild(option);
      }
      return select;
    };

    const toolbar = h(
      'div',
      { class: 'toolbar' },
      picker('leftId'),
      h('span', null, '→'),
      picker('rightId'),
      h(
        'button',
        {
          class: 'btn-primary',
          disabled: store.running,
          onClick: async () => {
            store.running = true;
            ctx.refresh();
            try {
              store.result = await ctx.rpc.call<CompareResult>('compare', {
                leftId: store.leftId,
                rightId: store.rightId,
              });
            } catch (err) {
              ctx.toast((err as Error).message, 'error');
            } finally {
              store.running = false;
              ctx.refresh();
            }
          },
        },
        store.running ? 'Comparing…' : 'Compare',
      ),
    );

    const body = h('div', { class: 'detail' });
    if (!store.result) {
      body.appendChild(
        emptyState(
          'Compare two servers',
          'Both servers are connected if needed, then their contracts are diffed: tools, parameters, types, required-ness, enum values and annotations.',
        ),
      );
    } else {
      body.appendChild(renderComparison(store.result));
    }

    return h('div', { class: 'logs-view' }, toolbar, body);
  },

  onEvent(ctx, name, payload) {
    if (name !== 'compare-target') {
      return;
    }
    const store = scratch(ctx);
    const target = payload as { leftId: string; rightId: string };
    store.leftId = target.leftId;
    store.rightId = target.rightId;
    store.result = undefined;
    ctx.refresh();
  },
};

function renderComparison(result: CompareResult): HTMLElement {
  const container = h('div');

  container.appendChild(
    h(
      'header',
      { class: 'detail-head' },
      h('h2', null, `${result.left} → ${result.right}`),
      result.breakingCount
        ? h('span', { class: 'badge badge-destructive' }, `${result.breakingCount} breaking`)
        : h('span', { class: 'badge badge-ok' }, 'no breaking changes'),
    ),
  );

  container.appendChild(
    h(
      'div',
      { class: 'section' },
      h('h3', null, 'Summary'),
      compareTable([
        ['', result.left, result.right],
        ['Version', result.versions.left ?? '—', result.versions.right ?? '—'],
        ['Protocol', result.protocols.left ?? '—', result.protocols.right ?? '—'],
        ['Tools', String(result.counts.tools[0]), String(result.counts.tools[1])],
        ['Resources', String(result.counts.resources[0]), String(result.counts.resources[1])],
        ['Prompts', String(result.counts.prompts[0]), String(result.counts.prompts[1])],
      ]),
    ),
  );

  if (result.tools.length === 0 && result.resources.length === 0 && result.prompts.length === 0) {
    container.appendChild(
      h('div', { class: 'section' }, h('p', null, '✔ The two contracts are identical.')),
    );
    return container;
  }

  if (result.tools.length) {
    const section = h('div', { class: 'section' }, h('h3', null, 'Tools'));
    for (const tool of result.tools) {
      section.appendChild(renderToolDiff(tool, result));
    }
    container.appendChild(section);
  }

  const others = [
    ...result.resources.map((r) => ({ name: r.uri, kind: r.kind, label: 'Resource' })),
    ...result.prompts.map((p) => ({ name: p.name, kind: p.kind, label: 'Prompt' })),
  ];
  if (others.length) {
    const section = h('div', { class: 'section' }, h('h3', null, 'Resources & prompts'));
    for (const entry of others) {
      section.appendChild(
        h(
          'div',
          { class: 'check' },
          h('span', { class: 'check-glyph' }, entry.kind === 'only-left' ? '−' : '+'),
          h(
            'div',
            { class: 'check-body' },
            h('div', { class: 'check-title mono' }, entry.name),
            h(
              'div',
              { class: 'muted small' },
              `${entry.label} exists only in ${entry.kind === 'only-left' ? result.left : result.right}`,
            ),
          ),
        ),
      );
    }
    container.appendChild(section);
  }

  return container;
}

function renderToolDiff(tool: ToolDiff, result: CompareResult): HTMLElement {
  const glyph = tool.kind === 'only-left' ? '−' : tool.kind === 'only-right' ? '+' : '~';
  const breaking = tool.kind === 'only-left' || tool.differences.some((d) => d.breaking);

  const body = h(
    'div',
    { class: 'check-body' },
    h(
      'div',
      { class: 'check-title mono' },
      tool.name,
      breaking ? h('span', { class: 'badge badge-destructive' }, 'breaking') : null,
    ),
  );

  if (tool.kind === 'only-left') {
    body.appendChild(
      h('div', { class: 'muted small' }, `Missing from ${result.right}`),
    );
  } else if (tool.kind === 'only-right') {
    body.appendChild(h('div', { class: 'muted small' }, `New in ${result.right}`));
  } else {
    for (const difference of tool.differences) {
      body.appendChild(
        h(
          'div',
          { class: `diff-row${difference.breaking ? ' breaking' : ''}` },
          h('code', null, difference.path),
          h('span', { class: 'muted small' }, difference.message),
          h(
            'span',
            { class: 'diff-values mono small' },
            `${difference.left ?? '—'} → ${difference.right ?? '—'}`,
          ),
        ),
      );
    }
  }

  return h('div', { class: 'check' }, h('span', { class: 'check-glyph' }, glyph), body);
}

function compareTable(rows: string[][]): HTMLElement {
  const table = h('div', { class: 'compare-table' });
  for (const [index, row] of rows.entries()) {
    table.appendChild(
      h(
        'div',
        { class: `compare-row${index === 0 ? ' compare-head' : ''}` },
        ...row.map((cell) => h('span', null, cell)),
      ),
    );
  }
  return table;
}
