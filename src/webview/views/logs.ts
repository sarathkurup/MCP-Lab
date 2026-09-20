import type { LogEntry } from '../../shared/viewModels';
import type { AppContext, ViewDefinition } from '../app';
import { h, pretty } from '../dom';
import { emptyState } from './explorer';

type Level = 'debug' | 'info' | 'warn' | 'error';

interface LogScratch {
  minLevel: Level;
  search: string;
  follow: boolean;
  listEl?: HTMLElement;
  entries: LogEntry[];
}

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function scratch(ctx: AppContext): LogScratch {
  const existing = ctx.state.scratch.logs as LogScratch | undefined;
  if (existing) {
    return existing;
  }
  const created: LogScratch = { minLevel: 'debug', search: '', follow: true, entries: [] };
  ctx.state.scratch.logs = created;
  return created;
}

function matches(entry: LogEntry, store: LogScratch): boolean {
  if (RANK[entry.level as Level] < RANK[store.minLevel]) {
    return false;
  }
  if (store.search && !entry.message.toLowerCase().includes(store.search.toLowerCase())) {
    return false;
  }
  return true;
}

export const logsView: ViewDefinition = {
  id: 'logs',
  label: 'Logs',
  glyph: '📋',

  async render(ctx) {
    const store = scratch(ctx);
    store.entries = await ctx.rpc.call<LogEntry[]>('logs', { serverId: ctx.state.serverId });

    if (store.entries.length === 0) {
      return emptyState(
        'No log lines yet.',
        'MCP Lab events, server stderr and MCP logging notifications all land here.',
      );
    }

    const list = h('div', { class: 'log-list mono' });
    store.listEl = list;
    for (const entry of store.entries.filter((e) => matches(e, store))) {
      list.appendChild(logRow(entry));
    }

    const toolbar = h(
      'div',
      { class: 'toolbar' },
      h('input', {
        class: 'control-input',
        type: 'search',
        placeholder: 'Search logs…',
        value: store.search,
        onInput: (event) => {
          store.search = (event.target as HTMLInputElement).value;
          ctx.refresh();
        },
      }),
      ...(['debug', 'info', 'warn', 'error'] as Level[]).map((level) =>
        h(
          'button',
          {
            class: `chip${store.minLevel === level ? ' active' : ''}`,
            onClick: () => {
              store.minLevel = level;
              ctx.refresh();
            },
          },
          level,
        ),
      ),
      h('span', { class: 'spacer' }),
      h(
        'button',
        {
          class: `btn-ghost${store.follow ? ' active' : ''}`,
          onClick: () => {
            store.follow = !store.follow;
            ctx.refresh();
          },
        },
        store.follow ? 'Following' : 'Follow',
      ),
      h(
        'button',
        {
          class: 'btn-ghost',
          onClick: () => {
            void navigator.clipboard.writeText(
              store.entries.map((e) => `${new Date(e.timestamp).toISOString()} ${e.level} ${e.message}`).join('\n'),
            );
            ctx.toast('Logs copied.');
          },
        },
        'Export',
      ),
      h(
        'button',
        {
          class: 'btn-ghost',
          onClick: async () => {
            await ctx.rpc.call('clearLogs', { serverId: ctx.state.serverId });
            ctx.refresh();
          },
        },
        'Clear',
      ),
    );

    return h('div', { class: 'logs-view' }, toolbar, list);
  },

  onEvent(ctx, name, payload) {
    if (name !== 'log') {
      return;
    }
    const store = scratch(ctx);
    if (!store.listEl) {
      return;
    }
    const entry = payload as LogEntry;
    if (ctx.state.serverId && entry.serverId && entry.serverId !== ctx.state.serverId) {
      return;
    }
    store.entries.push(entry);
    if (matches(entry, store)) {
      store.listEl.appendChild(logRow(entry));
      if (store.follow) {
        store.listEl.scrollTop = store.listEl.scrollHeight;
      }
    }
  },
};

function logRow(entry: LogEntry): HTMLElement {
  return h(
    'div',
    { class: `log-row level-${entry.level}` },
    h('span', { class: 'log-time' }, new Date(entry.timestamp).toISOString().slice(11, 23)),
    h('span', { class: `log-level level-${entry.level}` }, entry.level.toUpperCase()),
    h('span', { class: 'log-source' }, entry.source),
    h('span', { class: 'log-message' }, entry.message),
    entry.detail !== undefined ? h('span', { class: 'muted' }, pretty(entry.detail)) : null,
  );
}
