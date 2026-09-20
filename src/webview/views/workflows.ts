import type { HistoryEntry } from '../../shared/viewModels';
import type { TestAssertion } from '../../core/testing';
import type { StepResult, Workflow, WorkflowRun, WorkflowStep } from '../../core/workflows';
import type { AppContext, ViewDefinition } from '../app';
import { codeBlock, formatDuration, h, pretty } from '../dom';
import { emptyState } from './explorer';

interface WorkflowScratch {
  workflows: Workflow[];
  selectedId?: string;
  run?: WorkflowRun;
  liveSteps: StepResult[];
  running: boolean;
  recording: boolean;
  recorded: HistoryEntry[];
}

function scratch(ctx: AppContext): WorkflowScratch {
  const existing = ctx.state.scratch.workflows as WorkflowScratch | undefined;
  if (existing) {
    return existing;
  }
  const created: WorkflowScratch = {
    workflows: [],
    liveSteps: [],
    running: false,
    recording: false,
    recorded: [],
  };
  ctx.state.scratch.workflows = created;
  return created;
}

export const workflowsView: ViewDefinition = {
  id: 'workflows',
  label: 'Workflows',
  glyph: '🧩',

  async render(ctx) {
    const store = scratch(ctx);
    store.workflows = await ctx.rpc.call<Workflow[]>('workflows');
    const state = await ctx.rpc.call<{ recording: boolean; entries: HistoryEntry[] }>(
      'recordingState',
    );
    store.recording = state.recording;
    store.recorded = state.entries;

    const selected =
      store.workflows.find((workflow) => workflow.id === store.selectedId) ?? store.workflows[0];
    store.selectedId = selected?.id;

    return h(
      'div',
      { class: 'split' },
      h(
        'aside',
        { class: 'catalog' },
        recorderPanel(ctx, store),
        h(
          'div',
          { class: 'catalog-section' },
          h('h3', null, 'Workflows', h('span', { class: 'count' }, String(store.workflows.length))),
          ...store.workflows.map((workflow) =>
            h(
              'button',
              {
                class: `catalog-row${workflow.id === store.selectedId ? ' selected' : ''}`,
                onClick: () => {
                  store.selectedId = workflow.id;
                  store.run = undefined;
                  store.liveSteps = [];
                  ctx.refresh();
                },
              },
              h('div', { class: 'catalog-row-head' }, h('span', { class: 'catalog-name' }, workflow.name)),
              h('span', { class: 'catalog-desc' }, `${workflow.steps.length} step(s)`),
            ),
          ),
        ),
      ),
      h(
        'section',
        { class: 'detail' },
        selected
          ? renderWorkflow(ctx, store, selected)
          : emptyState(
              'No workflows yet.',
              'Record a sequence of calls and save it as a workflow, or write one as JSON in mcp-workflows/.',
            ),
      ),
    );
  },

  onEvent(ctx, name, payload) {
    const store = scratch(ctx);
    if (name === 'workflow-step') {
      store.liveSteps.push(payload as StepResult);
      ctx.refresh();
      return;
    }
    if (name === 'recording-changed') {
      store.recorded = payload as HistoryEntry[];
      ctx.refresh();
    }
  },
};

function recorderPanel(ctx: AppContext, store: WorkflowScratch): HTMLElement {
  return h(
    'div',
    { class: 'catalog-section recorder' },
    h('h3', null, 'Recorder'),
    h(
      'div',
      { class: 'catalog-search' },
      h(
        'button',
        {
          class: store.recording ? 'btn-secondary' : 'btn-primary',
          onClick: async () => {
            await ctx.rpc.call(store.recording ? 'stopRecording' : 'startRecording', {
              serverId: ctx.state.serverId,
            });
            ctx.refresh();
          },
        },
        store.recording ? '⏹ Stop' : '⏺ Record',
      ),
      store.recorded.length
        ? h('span', { class: 'muted small' }, `${store.recorded.length} captured`)
        : null,
    ),
    store.recorded.length
      ? h(
          'div',
          { class: 'catalog-rows' },
          ...store.recorded.map((entry) =>
            h(
              'div',
              { class: 'catalog-row' },
              h(
                'div',
                { class: 'catalog-row-head' },
                h('span', { class: 'catalog-name' }, entry.name),
                h(
                  'button',
                  {
                    class: 'btn-ghost',
                    title: 'Drop this step',
                    onClick: async () => {
                      await ctx.rpc.call('dropRecorded', { id: entry.id });
                      ctx.refresh();
                    },
                  },
                  '✕',
                ),
              ),
              h('span', { class: 'catalog-desc' }, formatDuration(entry.durationMs)),
            ),
          ),
        )
      : null,
    store.recorded.length
      ? h(
          'div',
          { class: 'catalog-footer' },
          h(
            'button',
            {
              class: 'btn-ghost',
              onClick: () => void ctx.rpc.call('saveRecordingAsWorkflow'),
            },
            'Save as workflow',
          ),
          h(
            'button',
            {
              class: 'btn-ghost',
              onClick: () => void ctx.rpc.call('saveRecordingAsTests'),
            },
            'Save as tests',
          ),
          h(
            'button',
            {
              class: 'btn-ghost',
              onClick: async () => {
                await ctx.rpc.call('replayRecording');
                ctx.toast('Replayed the recorded sequence.');
              },
            },
            'Replay',
          ),
        )
      : null,
  );
}

function renderWorkflow(
  ctx: AppContext,
  store: WorkflowScratch,
  workflow: Workflow,
): HTMLElement {
  const steps = store.run?.steps ?? store.liveSteps;
  const byId = new Map(steps.map((step) => [step.stepId, step]));

  const container = h(
    'div',
    { class: 'tool-detail' },
    h(
      'header',
      { class: 'detail-head' },
      h('h2', null, workflow.name),
      store.run
        ? h(
            'span',
            {
              class: `badge ${store.run.status === 'completed' ? 'badge-ok' : 'badge-destructive'}`,
            },
            store.run.status,
          )
        : null,
      store.run ? h('span', { class: 'muted' }, formatDuration(store.run.durationMs)) : null,
    ),
  );

  if (workflow.description) {
    container.appendChild(h('p', { class: 'detail-description' }, workflow.description));
  }

  container.appendChild(
    h(
      'div',
      { class: 'actions' },
      h(
        'button',
        {
          class: 'btn-primary',
          disabled: store.running,
          onClick: async () => {
            store.running = true;
            store.liveSteps = [];
            store.run = undefined;
            ctx.refresh();
            try {
              store.run = await ctx.rpc.call<WorkflowRun>('runWorkflow', {
                workflowId: workflow.id,
                serverId: ctx.state.serverId,
              });
            } catch (err) {
              ctx.toast((err as Error).message, 'error');
            } finally {
              store.running = false;
              ctx.refresh();
            }
          },
        },
        store.running ? 'Running…' : '▶ Execute workflow',
      ),
      workflow.sourceUri
        ? h(
            'button',
            {
              class: 'btn-ghost',
              onClick: () =>
                void ctx.rpc.call('openTestFile', { sourceUri: workflow.sourceUri }),
            },
            'Open JSON',
          )
        : null,
    ),
  );

  const flow = h('div', { class: 'flow' });
  for (const [index, step] of workflow.steps.entries()) {
    flow.appendChild(renderStep(step, byId.get(step.id)));
    if (index < workflow.steps.length - 1) {
      flow.appendChild(h('div', { class: 'flow-arrow' }, '↓'));
    }
  }
  container.appendChild(h('div', { class: 'section' }, h('h3', null, 'Steps'), flow));

  return container;
}

function renderStep(step: WorkflowStep, result?: StepResult): HTMLElement {
  const statusClass = result
    ? result.status === 'ok' || result.status.startsWith('branch')
      ? 'ok'
      : result.status === 'skipped'
        ? 'skip'
        : 'fail'
    : 'idle';

  const node = h(
    'div',
    { class: `flow-node flow-${statusClass}` },
    h(
      'div',
      { class: 'flow-head' },
      h('span', { class: 'flow-glyph' }, glyphFor(step, result)),
      h('span', { class: 'flow-name mono' }, step.name ?? step.tool ?? step.id),
      h('span', { class: 'badge' }, step.kind),
      result ? h('span', { class: 'muted small' }, formatDuration(result.durationMs)) : null,
    ),
  );

  if (step.kind === 'branch' && step.condition) {
    node.appendChild(
      h(
        'div',
        { class: 'muted small mono' },
        `if ${step.condition.path} ${describeCondition(step.condition)}`,
      ),
    );
  }

  if (step.input !== undefined && Object.keys(step.input as object).length > 0) {
    node.appendChild(
      h(
        'details',
        { class: 'collapsible' },
        h('summary', null, 'Input'),
        codeBlock(pretty(result?.input ?? step.input)),
      ),
    );
  }

  if (result?.error) {
    node.appendChild(h('div', { class: 'error-title small' }, result.error));
  } else if (result?.output !== undefined) {
    node.appendChild(
      h(
        'details',
        { class: 'collapsible' },
        h('summary', null, 'Output'),
        codeBlock(pretty(result.output)),
      ),
    );
  }

  return node;
}

function glyphFor(step: WorkflowStep, result?: StepResult): string {
  if (!result) {
    return step.kind === 'branch' ? '◇' : '▢';
  }
  switch (result.status) {
    case 'ok':
      return '✔';
    case 'failed':
      return '✘';
    case 'skipped':
      return '–';
    case 'branch-true':
      return '◆ yes';
    case 'branch-false':
      return '◇ no';
    default:
      return '·';
  }
}

function describeCondition(condition: TestAssertion): string {
  const keys = ['equals', 'contains', 'matches', 'type', 'exists', 'lessThan', 'greaterThan'] as const;
  for (const key of keys) {
    const value = condition[key];
    if (value !== undefined) {
      return `${key} ${JSON.stringify(value)}`;
    }
  }
  return '';
}
