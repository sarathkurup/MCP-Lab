import type { CatalogEntry, SearchHit } from '../../core/catalog';
import type { AppContext, ViewDefinition } from '../app';
import { formatDuration, h } from '../dom';
import { emptyState } from './explorer';

interface CatalogScratch {
  entries: CatalogEntry[];
  query: string;
  hits: SearchHit[];
  searching: boolean;
}

function scratch(ctx: AppContext): CatalogScratch {
  const existing = ctx.state.scratch.catalog as CatalogScratch | undefined;
  if (existing) {
    return existing;
  }
  const created: CatalogScratch = { entries: [], query: '', hits: [], searching: false };
  ctx.state.scratch.catalog = created;
  return created;
}

export const catalogView: ViewDefinition = {
  id: 'catalog',
  label: 'Catalog',
  glyph: '🏢',

  async render(ctx) {
    const store = scratch(ctx);
    store.entries = await ctx.rpc.call<CatalogEntry[]>('catalog');

    if (store.entries.length === 0) {
      return emptyState('No servers registered.', 'Add a server to see it here.');
    }

    const search = h('input', {
      class: 'control-input',
      type: 'search',
      placeholder: 'Search every server: tools, resources, prompts, owners…',
      value: store.query,
      onInput: (event) => {
        store.query = (event.target as HTMLInputElement).value;
        void runSearch(ctx, store);
      },
    });

    const toolbar = h('div', { class: 'toolbar' }, h('span', null, '🔎'), search);
    const body = h('div', { class: 'detail' });

    if (store.query.trim()) {
      body.appendChild(renderSearchResults(ctx, store));
    } else {
      body.appendChild(renderCatalog(ctx, store));
    }

    return h('div', { class: 'logs-view' }, toolbar, body);
  },
};

let searchTimer: ReturnType<typeof setTimeout> | undefined;

function runSearch(ctx: AppContext, store: CatalogScratch): void {
  // Debounced: search runs over every connected server's catalog.
  if (searchTimer) {
    clearTimeout(searchTimer);
  }
  searchTimer = setTimeout(async () => {
    if (!store.query.trim()) {
      store.hits = [];
      ctx.refresh();
      return;
    }
    store.searching = true;
    try {
      store.hits = await ctx.rpc.call<SearchHit[]>('search', { query: store.query });
    } catch (err) {
      ctx.toast((err as Error).message, 'error');
    } finally {
      store.searching = false;
      ctx.refresh();
    }
  }, 180);
}

function renderCatalog(ctx: AppContext, store: CatalogScratch): HTMLElement {
  const grid = h('div', { class: 'catalog-grid' });

  for (const entry of store.entries) {
    grid.appendChild(
      h(
        'div',
        { class: `catalog-card health-${entry.health}` },
        h(
          'div',
          { class: 'card-head' },
          h('span', { class: 'card-title' }, entry.name),
          h('span', { class: `badge health-badge-${entry.health}` }, entry.health),
        ),
        h(
          'div',
          { class: 'muted small' },
          [entry.metadata.team, entry.metadata.owner].filter(Boolean).join(' · ') || 'No owner set',
        ),
        entry.healthDetail ? h('div', { class: 'check-hint' }, entry.healthDetail) : null,
        h(
          'div',
          { class: 'card-stats' },
          stat('Tools', String(entry.counts.tools)),
          stat('Resources', String(entry.counts.resources)),
          stat('Prompts', String(entry.counts.prompts)),
          stat('Version', entry.version ?? '—'),
        ),
        h(
          'div',
          { class: 'card-risk' },
          h('span', { class: 'badge badge-read' }, `${entry.risk.read} read`),
          h('span', { class: 'badge' }, `${entry.risk.write} write`),
          entry.risk.destructive
            ? h('span', { class: 'badge badge-destructive' }, `${entry.risk.destructive} destructive`)
            : null,
        ),
        entry.usage && entry.usage.calls
          ? h(
              'div',
              { class: 'muted small' },
              `${entry.usage.calls} calls · ${(entry.usage.failureRate * 100).toFixed(1)}% failed · ${formatDuration(entry.usage.averageMs)} avg`,
            )
          : null,
        h(
          'div',
          { class: 'card-actions' },
          h(
            'button',
            {
              class: 'btn-ghost',
              onClick: () => {
                ctx.state.serverId = entry.id;
                ctx.navigate('explorer');
              },
            },
            'Explore',
          ),
          h(
            'button',
            {
              class: 'btn-ghost',
              onClick: () => {
                ctx.state.serverId = entry.id;
                ctx.navigate('doctor');
              },
            },
            'Diagnose',
          ),
          entry.metadata.documentation
            ? h(
                'button',
                {
                  class: 'btn-ghost',
                  onClick: () =>
                    void ctx.rpc.call('openExternal', { url: entry.metadata.documentation }),
                },
                'Docs',
              )
            : null,
          entry.metadata.repository
            ? h(
                'button',
                {
                  class: 'btn-ghost',
                  onClick: () =>
                    void ctx.rpc.call('openExternal', { url: entry.metadata.repository }),
                },
                'Repo',
              )
            : null,
        ),
      ),
    );
  }

  return grid;
}

function renderSearchResults(ctx: AppContext, store: CatalogScratch): HTMLElement {
  if (store.searching && store.hits.length === 0) {
    return h('p', { class: 'muted' }, 'Searching…');
  }
  if (store.hits.length === 0) {
    return emptyState(
      `Nothing matches "${store.query}".`,
      'Search covers connected servers only - a disconnected server has no catalog to search.',
    );
  }

  const grouped = new Map<string, SearchHit[]>();
  for (const hit of store.hits) {
    const list = grouped.get(hit.serverName) ?? [];
    list.push(hit);
    grouped.set(hit.serverName, list);
  }

  const container = h('div');
  for (const [serverName, hits] of grouped) {
    const section = h(
      'div',
      { class: 'section' },
      h('h3', null, serverName, h('span', { class: 'count' }, String(hits.length))),
    );
    for (const hit of hits) {
      section.appendChild(
        h(
          'button',
          {
            class: 'catalog-row',
            onClick: () => {
              ctx.state.serverId = hit.serverId;
              if (hit.kind !== 'server') {
                ctx.state.selection = { kind: hit.kind, name: hit.name };
              }
              ctx.navigate('explorer');
            },
          },
          h(
            'div',
            { class: 'catalog-row-head' },
            h('span', { class: 'catalog-name mono' }, hit.name),
            h('span', { class: 'badge' }, hit.kind),
            hit.risk === 'destructive'
              ? h('span', { class: 'badge badge-destructive' }, 'destructive')
              : null,
          ),
          hit.description ? h('span', { class: 'catalog-desc' }, hit.description) : null,
        ),
      );
    }
    container.appendChild(section);
  }
  return container;
}

function stat(label: string, value: string): HTMLElement {
  return h(
    'div',
    { class: 'card-stat' },
    h('span', { class: 'card-stat-value' }, value),
    h('span', { class: 'card-stat-label' }, label),
  );
}
