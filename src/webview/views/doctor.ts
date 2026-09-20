import type { DiagnosticCheck, DiagnosticReport } from '../../core/doctor';
import type { LintFinding } from '../../core/linter';
import type { AppContext, ViewDefinition } from '../app';
import { formatDateTime, h } from '../dom';
import { emptyState } from './explorer';

interface DoctorScratch {
  report?: DiagnosticReport;
  lint?: { findings: LintFinding[]; anchored: number };
  running: boolean;
  probe: boolean;
  ruleFilter?: string;
}

function scratch(ctx: AppContext): DoctorScratch {
  const existing = ctx.state.scratch.doctor as DoctorScratch | undefined;
  if (existing) {
    return existing;
  }
  const created: DoctorScratch = { running: false, probe: true };
  ctx.state.scratch.doctor = created;
  return created;
}

export const doctorView: ViewDefinition = {
  id: 'doctor',
  label: 'Doctor',
  glyph: '🩺',

  async render(ctx) {
    const store = scratch(ctx);
    const server = ctx.currentServer();

    if (!server) {
      return emptyState('No server selected.', '');
    }

    const header = h(
      'div',
      { class: 'toolbar' },
      h(
        'button',
        {
          class: 'btn-primary',
          disabled: store.running,
          onClick: () => void runDiagnostics(ctx, store, server.id),
        },
        store.running ? 'Running…' : 'Run diagnostics',
      ),
      h(
        'label',
        { class: 'inline-check' },
        h('input', {
          type: 'checkbox',
          checked: store.probe,
          onChange: (event) => {
            store.probe = (event.target as HTMLInputElement).checked;
          },
        }),
        'Send live probes (ping, unknown-tool)',
      ),
      h('span', { class: 'spacer' }),
      h(
        'button',
        {
          class: 'btn-secondary',
          onClick: () => void runLint(ctx, store, server.id, true),
        },
        'Lint → Problems panel',
      ),
    );

    const body = h('div', { class: 'detail' });

    if (!store.report) {
      body.appendChild(
        emptyState(
          `Diagnose ${server.name}`,
          'Twelve checks across connectivity, protocol, capabilities, schema quality, security and test coverage. Probes are read-only: a ping and a deliberately unknown tool name.',
        ),
      );
    } else {
      body.appendChild(renderReport(ctx, store, store.report));
    }

    return h('div', { class: 'logs-view' }, header, body);
  },
};

async function runDiagnostics(
  ctx: AppContext,
  store: DoctorScratch,
  serverId: string,
): Promise<void> {
  store.running = true;
  ctx.refresh();
  try {
    store.report = await ctx.rpc.call<DiagnosticReport>('diagnose', {
      serverId,
      probe: store.probe,
    });
    store.lint = await ctx.rpc.call('lint', { serverId });
  } catch (err) {
    ctx.toast((err as Error).message, 'error');
  } finally {
    store.running = false;
    ctx.refresh();
  }
}

async function runLint(
  ctx: AppContext,
  store: DoctorScratch,
  serverId: string,
  publish: boolean,
): Promise<void> {
  try {
    store.lint = await ctx.rpc.call('lint', { serverId, publish });
    ctx.toast(
      publish
        ? `${store.lint?.findings.length ?? 0} finding(s); ${store.lint?.anchored ?? 0} anchored to source files.`
        : `${store.lint?.findings.length ?? 0} finding(s).`,
    );
    ctx.refresh();
  } catch (err) {
    ctx.toast((err as Error).message, 'error');
  }
}

function renderReport(
  ctx: AppContext,
  store: DoctorScratch,
  report: DiagnosticReport,
): HTMLElement {
  const container = h('div', { class: 'doctor' });

  container.appendChild(
    h(
      'header',
      { class: 'detail-head' },
      h('h2', null, `🩺 ${report.serverName}`),
      h('span', { class: 'badge badge-ok' }, `${report.passed} passed`),
      report.warnings ? h('span', { class: 'badge badge-warn' }, `${report.warnings} warnings`) : null,
      report.errors ? h('span', { class: 'badge badge-destructive' }, `${report.errors} errors`) : null,
      h('span', { class: 'muted small' }, formatDateTime(report.timestamp)),
    ),
  );

  const groups = new Map<string, DiagnosticCheck[]>();
  for (const check of report.checks) {
    const list = groups.get(check.group) ?? [];
    list.push(check);
    groups.set(check.group, list);
  }

  for (const [group, checks] of groups) {
    const section = h('div', { class: 'section' }, h('h3', null, group));
    for (const check of checks) {
      section.appendChild(renderCheck(ctx, check));
    }
    container.appendChild(section);
  }

  if (store.lint?.findings.length) {
    container.appendChild(renderFindings(ctx, store));
  }

  return container;
}

function renderCheck(ctx: AppContext, check: DiagnosticCheck): HTMLElement {
  return h(
    'div',
    { class: `check check-${check.status}` },
    h('span', { class: 'check-glyph' }, glyphFor(check.status)),
    h(
      'div',
      { class: 'check-body' },
      h('div', { class: 'check-title' }, check.title),
      h('div', { class: 'muted small' }, check.detail),
      check.hint ? h('div', { class: 'check-hint' }, check.hint) : null,
    ),
    check.fixCommand
      ? h(
          'button',
          {
            class: 'btn-ghost',
            onClick: () =>
              void ctx.rpc.call('runFix', {
                command: check.fixCommand,
                serverId: ctx.state.serverId,
              }),
          },
          'Fix',
        )
      : null,
  );
}

function renderFindings(ctx: AppContext, store: DoctorScratch): HTMLElement {
  const findings = store.lint!.findings;
  const rules = [...new Set(findings.map((f) => f.rule))].sort();

  const section = h(
    'div',
    { class: 'section' },
    h(
      'div',
      { class: 'section-head' },
      h('h3', null, `Lint (${findings.length})`),
      h(
        'div',
        { class: 'filter-row' },
        h(
          'button',
          {
            class: `chip${!store.ruleFilter ? ' active' : ''}`,
            onClick: () => {
              store.ruleFilter = undefined;
              ctx.refresh();
            },
          },
          'all',
        ),
        ...rules.map((rule) =>
          h(
            'button',
            {
              class: `chip${store.ruleFilter === rule ? ' active' : ''}`,
              onClick: () => {
                store.ruleFilter = rule;
                ctx.refresh();
              },
            },
            rule,
          ),
        ),
      ),
    ),
  );

  for (const finding of findings) {
    if (store.ruleFilter && finding.rule !== store.ruleFilter) {
      continue;
    }
    section.appendChild(
      h(
        'div',
        { class: `check check-${finding.severity === 'error' ? 'fail' : finding.severity === 'warning' ? 'warn' : 'skip'}` },
        h('span', { class: 'check-glyph mono' }, finding.rule),
        h(
          'div',
          { class: 'check-body' },
          h('div', { class: 'check-title' }, finding.message),
          finding.hint ? h('div', { class: 'check-hint' }, finding.hint) : null,
        ),
        finding.target.kind === 'tool'
          ? h(
              'button',
              {
                class: 'btn-ghost',
                onClick: () => {
                  ctx.state.selection = { kind: 'tool', name: finding.target.name };
                  ctx.navigate('explorer');
                },
              },
              'View',
            )
          : null,
      ),
    );
  }

  return section;
}

function glyphFor(status: DiagnosticCheck['status']): string {
  switch (status) {
    case 'pass':
      return '✔';
    case 'warn':
      return '⚠';
    case 'fail':
      return '✘';
    default:
      return '–';
  }
}
