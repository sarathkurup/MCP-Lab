import type { SecurityFinding, SecurityReport, Severity } from '../../core/security';
import type { AppContext, ViewDefinition } from '../app';
import { formatDateTime, h } from '../dom';
import { emptyState } from './explorer';

interface SecurityScratch {
  report?: SecurityReport;
  running: boolean;
  severityFilter?: Severity;
}

function scratch(ctx: AppContext): SecurityScratch {
  const existing = ctx.state.scratch.security as SecurityScratch | undefined;
  if (existing) {
    return existing;
  }
  const created: SecurityScratch = { running: false };
  ctx.state.scratch.security = created;
  return created;
}

export const securityView: ViewDefinition = {
  id: 'security',
  label: 'Security',
  glyph: '🔐',

  async render(ctx) {
    const store = scratch(ctx);
    const server = ctx.currentServer();
    if (!server) {
      return emptyState('No server selected.', '');
    }

    const toolbar = h(
      'div',
      { class: 'toolbar' },
      h(
        'button',
        {
          class: 'btn-primary',
          disabled: store.running,
          onClick: async () => {
            store.running = true;
            ctx.refresh();
            try {
              store.report = await ctx.rpc.call<SecurityReport>('securityScan', {
                serverId: server.id,
              });
            } catch (err) {
              ctx.toast((err as Error).message, 'error');
            } finally {
              store.running = false;
              ctx.refresh();
            }
          },
        },
        store.running ? 'Scanning…' : 'Run security scan',
      ),
      h('span', { class: 'spacer' }),
      store.report
        ? h('span', { class: 'muted small' }, formatDateTime(store.report.timestamp))
        : null,
    );

    const body = h('div', { class: 'detail' });

    if (!store.report) {
      body.appendChild(
        emptyState(
          `Scan ${server.name}`,
          'Reviews the configuration, the advertised catalog, and what has already passed through this session’s logs and history. Workbench cannot read server source, so it never claims to - every finding names its evidence.',
        ),
      );
      return h('div', { class: 'logs-view' }, toolbar, body);
    }

    body.appendChild(renderReport(ctx, store, store.report));
    return h('div', { class: 'logs-view' }, toolbar, body);
  },
};

function renderReport(
  ctx: AppContext,
  store: SecurityScratch,
  report: SecurityReport,
): HTMLElement {
  const container = h('div');

  container.appendChild(
    h(
      'header',
      { class: 'detail-head' },
      h('h2', null, `🔐 ${report.serverName}`),
      ...(['critical', 'high', 'medium', 'low'] as Severity[]).map((severity) =>
        report.counts[severity]
          ? h(
              'button',
              {
                class: `chip sev-${severity}${store.severityFilter === severity ? ' active' : ''}`,
                onClick: () => {
                  store.severityFilter = store.severityFilter === severity ? undefined : severity;
                  ctx.refresh();
                },
              },
              `${report.counts[severity]} ${severity}`,
            )
          : null,
      ),
    ),
  );

  if (report.findings.length === 0) {
    container.appendChild(
      h(
        'div',
        { class: 'section' },
        h('p', null, '✔ Nothing found in the configuration, catalog, logs or history.'),
        h(
          'p',
          { class: 'muted small' },
          'This is not a substitute for reviewing the server’s own source and deployment.',
        ),
      ),
    );
    return container;
  }

  const section = h('div', { class: 'section' });
  for (const finding of report.findings) {
    if (store.severityFilter && finding.severity !== store.severityFilter) {
      continue;
    }
    section.appendChild(renderFinding(finding));
  }
  container.appendChild(section);
  return container;
}

function renderFinding(finding: SecurityFinding): HTMLElement {
  return h(
    'div',
    { class: `check sev-row-${finding.severity}` },
    h('span', { class: `check-glyph badge sev-${finding.severity}` }, finding.severity),
    h(
      'div',
      { class: 'check-body' },
      h(
        'div',
        { class: 'check-title' },
        finding.title,
        h('span', { class: 'muted small mono' }, ` ${finding.id}`),
        finding.target ? h('span', { class: 'muted small' }, ` · ${finding.target}`) : null,
      ),
      h('div', { class: 'muted small' }, finding.detail),
      h('div', { class: 'check-hint' }, `Evidence: ${finding.evidence} · ${finding.remediation}`),
    ),
  );
}
