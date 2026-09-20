import type { TraceEntry } from '../../shared/viewModels';
import type { AppContext, ViewDefinition } from '../app';
import { codeBlock, formatDuration, h, pretty } from '../dom';
import { emptyState } from './explorer';

type Filter = 'all' | 'requests' | 'responses' | 'errors' | 'notifications';

interface TraceScratch {
  filter: Filter;
  search: string;
  paused: boolean;
  selected?: number;
  listEl?: HTMLElement;
  entries: TraceEntry[];
}

function scratch(ctx: AppContext): TraceScratch {
  const existing = ctx.state.scratch.trace as TraceScratch | undefined;
  if (existing) {
    return existing;
  }
  const created: TraceScratch = { filter: 'all', search: '', paused: false, entries: [] };
  ctx.state.scratch.trace = created;
  return created;
}

function matches(entry: TraceEntry, store: TraceScratch): boolean {
  if (store.filter === 'requests' && entry.kind !== 'request') {
    return false;
  }
  if (store.filter === 'responses' && entry.kind !== 'response') {
    return false;
  }
  if (store.filter === 'errors' && entry.kind !== 'error') {
    return false;
  }
  if (store.filter === 'notifications' && entry.kind !== 'notification') {
    return false;
  }
  if (store.search) {
    const needle = store.search.toLowerCase();
    return (
      (entry.method ?? '').toLowerCase().includes(needle) ||
      JSON.stringify(entry.message).toLowerCase().includes(needle)
    );
  }
  return true;
}

export const traceView: ViewDefinition = {
  id: 'trace',
  label: 'Protocol',
  glyph: '⇄',

  async render(ctx) {
    const store = scratch(ctx);
    store.entries = await ctx.rpc.call<TraceEntry[]>('trace', { serverId: ctx.state.serverId });

    const list = h('div', { class: 'trace-list' });
    store.listEl = list;

    const visible = store.entries.filter((e) => matches(e, store));
    for (const entry of visible) {
      list.appendChild(traceRow(ctx, store, entry));
    }

    if (store.entries.length === 0) {
      return emptyState(
        'No protocol frames yet.',
        'Every JSON-RPC message in both directions is captured here as soon as a server connects.',
      );
    }

    const detail = h('div', { class: 'trace-detail' });
    const selected =
      visible.find((e) => e.seq === store.selected) ?? visible[visible.length - 1];
    if (selected) {
      store.selected = selected.seq;
      detail.appendChild(renderFrame(selected));
    }

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
            placeholder: 'Search frames…',
            value: store.search,
            onInput: (event) => {
              store.search = (event.target as HTMLInputElement).value;
              ctx.refresh();
            },
          }),
        ),
        h(
          'div',
          { class: 'filter-row' },
          ...(['all', 'requests', 'responses', 'errors', 'notifications'] as Filter[]).map((filter) =>
            h(
              'button',
              {
                class: `chip${store.filter === filter ? ' active' : ''}`,
                onClick: () => {
                  store.filter = filter;
                  ctx.refresh();
                },
              },
              filter,
            ),
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
              onClick: () => {
                store.paused = !store.paused;
                ctx.refresh();
              },
            },
            store.paused ? '▶ Resume' : '⏸ Pause',
          ),
          h(
            'button',
            {
              class: 'btn-ghost',
              onClick: async () => {
                await ctx.rpc.call('clearTrace', { serverId: ctx.state.serverId });
                ctx.refresh();
              },
            },
            'Clear',
          ),
          h(
            'button',
            {
              class: 'btn-ghost',
              onClick: () => {
                void navigator.clipboard.writeText(pretty(store.entries));
                ctx.toast('Trace copied.');
              },
            },
            'Export',
          ),
        ),
      ),
      h('section', { class: 'detail' }, detail),
    );
  },

  onEvent(ctx, name, payload) {
    if (name !== 'trace') {
      return;
    }
    const store = scratch(ctx);
    if (store.paused || !store.listEl) {
      return;
    }
    const entry = payload as TraceEntry;
    if (ctx.state.serverId && entry.serverId !== ctx.state.serverId) {
      return;
    }
    store.entries.push(entry);
    if (matches(entry, store)) {
      store.listEl.appendChild(traceRow(ctx, store, entry));
      store.listEl.scrollTop = store.listEl.scrollHeight;
    }
  },
};

function traceRow(ctx: AppContext, store: TraceScratch, entry: TraceEntry): HTMLElement {
  const outbound = entry.direction === 'client->server';
  return h(
    'button',
    {
      class: `trace-row kind-${entry.kind}${entry.seq === store.selected ? ' selected' : ''}`,
      onClick: () => {
        store.selected = entry.seq;
        ctx.refresh();
      },
    },
    h('span', { class: `arrow ${outbound ? 'out' : 'in'}` }, outbound ? '→' : '←'),
    h('span', { class: 'trace-method' }, entry.method ?? `#${String(entry.id)}`),
    h('span', { class: `badge badge-${entry.kind}` }, entry.kind),
    entry.durationMs !== undefined
      ? h('span', { class: 'muted small' }, formatDuration(entry.durationMs))
      : null,
  );
}

function renderFrame(entry: TraceEntry): HTMLElement {
  return h(
    'div',
    { class: 'tool-detail' },
    h(
      'header',
      { class: 'detail-head' },
      h('h2', null, entry.method ?? `Frame #${entry.seq}`),
      h('span', { class: `badge badge-${entry.kind}` }, entry.kind),
      h(
        'span',
        { class: 'badge' },
        entry.direction === 'client->server' ? 'client → server' : 'server → client',
      ),
    ),
    h(
      'dl',
      { class: 'meta-grid' },
      meta('Sequence', String(entry.seq)),
      meta('Time', new Date(entry.timestamp).toISOString().slice(11, 23)),
      meta('JSON-RPC id', entry.id === undefined || entry.id === null ? '—' : String(entry.id)),
      meta('Round trip', entry.durationMs !== undefined ? formatDuration(entry.durationMs) : '—'),
    ),
    codeBlock(pretty(entry.message)),
  );
}

function meta(label: string, value: string): HTMLElement {
  return h('div', { class: 'meta' }, h('dt', null, label), h('dd', null, value));
}
