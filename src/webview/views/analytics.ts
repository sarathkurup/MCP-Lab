import type { AnalyticsSummary } from '../../core/history';
import type { ViewDefinition } from '../app';
import { formatDuration, h } from '../dom';
import { emptyState } from './explorer';

export const analyticsView: ViewDefinition = {
  id: 'analytics',
  label: 'Analytics',
  glyph: '📊',

  async render(ctx) {
    const scope = (ctx.state.scratch.analyticsScope as 'server' | 'all') ?? 'server';
    const stats = await ctx.rpc.call<AnalyticsSummary>('analytics', {
      serverId: scope === 'server' ? ctx.state.serverId : undefined,
    });

    if (stats.total === 0) {
      return emptyState(
        'Nothing to measure yet.',
        'Analytics are computed from the invocation history, so they cover every call made through MCP Lab - explorer, replay, tests and workflows alike.',
      );
    }

    const successRate = stats.total ? (stats.succeeded / stats.total) * 100 : 0;

    const tiles = h(
      'div',
      { class: 'tiles' },
      tile('Total calls', String(stats.total)),
      tile('Succeeded', String(stats.succeeded), 'ok'),
      tile('Failed', String(stats.failed), stats.failed ? 'bad' : undefined),
      tile('Success rate', `${successRate.toFixed(1)}%`, successRate > 95 ? 'ok' : 'warn'),
      tile('Average', formatDuration(stats.averageMs)),
      tile('Median', formatDuration(stats.p50Ms)),
      tile('p95', formatDuration(stats.p95Ms), stats.p95Ms > 2000 ? 'warn' : undefined),
    );

    const maxCalls = Math.max(...stats.byTarget.map((t) => t.calls), 1);
    const rows = h('div', { class: 'bar-rows' });
    for (const target of stats.byTarget.slice(0, 25)) {
      rows.appendChild(
        h(
          'div',
          { class: 'bar-row' },
          h('span', { class: 'bar-label mono' }, target.name),
          h(
            'span',
            { class: 'bar-track' },
            h('span', {
              class: `bar-fill${target.failureRate > 0.05 ? ' bar-warn' : ''}`,
              style: { width: `${(target.calls / maxCalls) * 100}%` },
            }),
          ),
          h('span', { class: 'bar-value' }, String(target.calls)),
          h(
            'span',
            { class: `bar-value ${target.failureRate > 0 ? 'bad' : 'muted'}` },
            target.failureRate > 0 ? `${(target.failureRate * 100).toFixed(1)}% fail` : '—',
          ),
          h('span', { class: 'bar-value muted' }, formatDuration(target.averageMs)),
        ),
      );
    }

    return h(
      'div',
      { class: 'detail' },
      h(
        'div',
        { class: 'section-head' },
        h('h2', null, 'Analytics'),
        h(
          'button',
          {
            class: 'btn-ghost',
            onClick: () => {
              ctx.state.scratch.analyticsScope = scope === 'server' ? 'all' : 'server';
              ctx.refresh();
            },
          },
          scope === 'server' ? 'This server' : 'All servers',
        ),
      ),
      tiles,
      h('div', { class: 'section' }, h('h3', null, 'By target'), rows),
      h(
        'p',
        { class: 'muted small' },
        'Percentiles are computed over the retained history window, not over the server’s whole lifetime.',
      ),
    );
  },
};

function tile(label: string, value: string, tone?: 'ok' | 'warn' | 'bad'): HTMLElement {
  return h(
    'div',
    { class: `tile${tone ? ' tile-' + tone : ''}` },
    h('div', { class: 'tile-value' }, value),
    h('div', { class: 'tile-label' }, label),
  );
}
