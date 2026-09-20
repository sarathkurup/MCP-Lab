import type { ExecutionView, HistoryEntry } from '../../shared/viewModels';
import type { AppContext, ViewDefinition } from '../app';
import { codeBlock, formatDateTime, formatDuration, h, pretty } from '../dom';
import { renderResult } from '../resultViewer';
import { emptyState } from './explorer';

interface HistoryScratch {
  entries: HistoryEntry[];
  selectedId?: string;
  search: string;
  scope: 'server' | 'all';
}

function scratch(ctx: AppContext): HistoryScratch {
  const existing = ctx.state.scratch.history as HistoryScratch | undefined;
  if (existing) {
    return existing;
  }
  const created: HistoryScratch = { entries: [], search: '', scope: 'server' };
  ctx.state.scratch.history = created;
  return created;
}

export const historyView: ViewDefinition = {
  id: 'history',
  label: 'History',
  glyph: '🕘',

  async render(ctx) {
    const store = scratch(ctx);
    store.entries = await ctx.rpc.call<HistoryEntry[]>('history', {
      serverId: store.scope === 'server' ? ctx.state.serverId : undefined,
      search: store.search || undefined,
    });

    if (store.entries.length === 0) {
      return emptyState(
        'No invocations yet.',
        'Every tool call, resource read and prompt run is recorded here and can be replayed.',
      );
    }

    const list = h('div', { class: 'history-list' });
    for (const entry of store.entries) {
      list.appendChild(row(ctx, store, entry));
    }

    const detail = h('div', { class: 'history-detail' });
    const selected = store.entries.find((e) => e.id === store.selectedId) ?? store.entries[0];
    store.selectedId = selected.id;
    detail.appendChild(renderEntry(ctx, selected));

    return h(
      'div',
      { class: 'split' },
      h(
        'aside',
        { class: 'catalog' },
        h(
          'div',
          { class: 'catalog-search' },
          h('input', {
            class: 'control-input',
            type: 'search',
            placeholder: 'Filter by name…',
            value: store.search,
            onInput: (event) => {
              store.search = (event.target as HTMLInputElement).value;
              ctx.refresh();
            },
          }),
          h(
            'button',
            {
              class: 'btn-ghost',
              title: 'Toggle between this server and all servers',
              onClick: () => {
                store.scope = store.scope === 'server' ? 'all' : 'server';
                ctx.refresh();
              },
            },
            store.scope === 'server' ? 'This server' : 'All servers',
          ),
        ),
        list,
        h(
          'div',
          { class: 'catalog-footer' },
          h(
            'button',
            {
              class: 'btn-ghost',
              onClick: async () => {
                await ctx.rpc.call('clearHistory', {
                  serverId: store.scope === 'server' ? ctx.state.serverId : undefined,
                });
                store.selectedId = undefined;
                ctx.refresh();
              },
            },
            'Clear history',
          ),
        ),
      ),
      h('section', { class: 'detail' }, detail),
    );
  },
};

function row(ctx: AppContext, store: HistoryScratch, entry: HistoryEntry): HTMLElement {
  const failed = !!entry.error;
  const warned = !!entry.toolError;
  return h(
    'button',
    {
      class: `catalog-row${entry.id === store.selectedId ? ' selected' : ''}`,
      onClick: () => {
        store.selectedId = entry.id;
        ctx.refresh();
      },
    },
    h(
      'div',
      { class: 'catalog-row-head' },
      h('span', { class: 'catalog-name' }, entry.name),
      h(
        'span',
        { class: `badge ${failed ? 'badge-destructive' : warned ? 'badge-warn' : 'badge-ok'}` },
        failed ? 'fail' : warned ? 'warn' : 'ok',
      ),
    ),
    h(
      'span',
      { class: 'catalog-desc' },
      `${new Date(entry.timestamp).toTimeString().slice(0, 8)} · ${formatDuration(entry.durationMs)} · ${entry.serverName}`,
    ),
  );
}

function renderEntry(ctx: AppContext, entry: HistoryEntry): HTMLElement {
  const view: ExecutionView = { entry, ok: !entry.error };
  return h(
    'div',
    { class: 'tool-detail' },
    h(
      'header',
      { class: 'detail-head' },
      h('h2', null, entry.name),
      h('span', { class: 'badge' }, entry.kind),
      entry.environment ? h('span', { class: 'badge badge-env' }, entry.environment) : null,
    ),
    h(
      'dl',
      { class: 'meta-grid' },
      meta('Server', entry.serverName),
      meta('When', formatDateTime(entry.timestamp)),
      meta('Duration', formatDuration(entry.durationMs)),
      meta('Invocation', entry.id),
    ),
    h(
      'div',
      { class: 'actions' },
      h(
        'button',
        {
          class: 'btn-primary',
          onClick: async () => {
            try {
              await ctx.rpc.call('replay', { historyId: entry.id });
              ctx.toast('Replayed.');
              ctx.refresh();
            } catch (err) {
              ctx.toast((err as Error).message, 'error');
            }
          },
        },
        'Replay',
      ),
      h(
        'button',
        {
          class: 'btn-secondary',
          onClick: () => void ctx.rpc.call('saveAsTest', { historyId: entry.id }),
        },
        'Save as test',
      ),
      h(
        'button',
        {
          class: 'btn-ghost',
          onClick: () => {
            void navigator.clipboard.writeText(pretty({ input: entry.input, output: entry.output }));
            ctx.toast('Copied.');
          },
        },
        'Copy',
      ),
    ),
    renderResult(ctx, view),
    h('details', { class: 'collapsible' }, h('summary', null, 'Raw entry'), codeBlock(pretty(entry))),
  );
}

function meta(label: string, value: string): HTMLElement {
  return h('div', { class: 'meta' }, h('dt', null, label), h('dd', null, value));
}
