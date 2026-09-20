import type { HistoryEntry } from '../../shared/viewModels';
import type { TestAssertion } from '../../core/testing';
import {
  buildWorkflowGraph,
  type StepResult,
  type Workflow,
  type WorkflowRun,
  type WorkflowStep,
} from '../../core/workflows';
import type { AppContext, ViewDefinition } from '../app';
import { codeBlock, formatDuration, h, pretty, svg } from '../dom';
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

  container.appendChild(
    h(
      'div',
      { class: 'section' },
      h('h3', null, 'Flow'),
      renderFlowDiagram(workflow, byId),
    ),
  );

  // The cards carry the detail the diagram cannot: inputs, outputs, errors.
  const flow = h('div', { class: 'flow' });
  for (const step of workflow.steps) {
    flow.appendChild(renderStep(step, byId.get(step.id)));
  }
  container.appendChild(h('div', { class: 'section' }, h('h3', null, 'Steps'), flow));

  return container;
}

const NODE_W = 236;
const NODE_H = 30;
const ROW = 52;
const GUTTER = 76;
const PAD = 10;

/**
 * The workflow drawn as its real successor graph.
 *
 * The previous rendering put an arrow between every consecutive pair of steps,
 * which is a lie as soon as a workflow branches: an arm does not run into the
 * one below it. Edges here come from buildWorkflowGraph, the same derivation
 * the runner follows, so the picture and the execution cannot disagree.
 */
function renderFlowDiagram(workflow: Workflow, byId: Map<string, StepResult>): HTMLElement {
  const graph = buildWorkflowGraph(workflow);
  const index = new Map(workflow.steps.map((step, i) => [step.id, i]));

  const height = PAD * 2 + Math.max(1, workflow.steps.length) * ROW - (ROW - NODE_H);
  const width = NODE_W + GUTTER;

  const canvas = svg('svg', {
    class: 'flow-canvas',
    viewBox: `0 0 ${width} ${height}`,
    width: String(width),
    height: String(height),
    role: 'img',
    'aria-label': `Flow diagram for ${workflow.name}`,
  });

  canvas.appendChild(
    svg(
      'defs',
      null,
      svg(
        'marker',
        {
          id: 'flow-arrow-head',
          viewBox: '0 0 8 8',
          refX: '7',
          refY: '4',
          markerWidth: '6',
          markerHeight: '6',
          orient: 'auto-start-reverse',
        },
        svg('path', { d: 'M 0 0 L 8 4 L 0 8 z', class: 'flow-arrow-head' }),
      ),
    ),
  );

  const yOf = (id: string) => PAD + (index.get(id) ?? 0) * ROW;

  // Edges first so the nodes paint over them.
  for (const edge of graph.edges) {
    const from = index.get(edge.from);
    const to = index.get(edge.to);
    if (from === undefined || to === undefined) continue;

    const y1 = yOf(edge.from);
    const y2 = yOf(edge.to);
    const adjacent = to === from + 1;
    // Lane the jump routes through, also used to park its label clear of the curve.
    const lane = NODE_W + 16 + (Math.abs(to - from) % 3) * 16;
    const tone = edge.label === 'true' ? ' flow-edge-true' : edge.label === 'false' ? ' flow-edge-false' : '';

    if (adjacent) {
      canvas.appendChild(
        svg('path', {
          d: `M ${NODE_W / 2} ${y1 + NODE_H} L ${NODE_W / 2} ${y2}`,
          class: 'flow-edge' + tone,
          fill: 'none',
          'marker-end': 'url(#flow-arrow-head)',
        }),
      );
    } else {
      // Anything that jumps routes through the right gutter, so a long edge
      // never crosses the nodes it skips.
      canvas.appendChild(
        svg('path', {
          d:
            `M ${NODE_W} ${y1 + NODE_H / 2} ` +
            `C ${lane} ${y1 + NODE_H / 2}, ${lane} ${y2 + NODE_H / 2}, ` +
            `${NODE_W} ${y2 + NODE_H / 2}`,
          class: 'flow-edge' + tone,
          fill: 'none',
          'marker-end': 'url(#flow-arrow-head)',
        }),
      );
    }

    if (edge.label !== 'then') {
      const labelY = adjacent ? (y1 + NODE_H + y2) / 2 + 3 : (y1 + y2) / 2 + NODE_H / 2;
      const labelX = adjacent ? NODE_W / 2 + 6 : lane + 6;
      canvas.appendChild(
        svg('text', { class: 'flow-edge-label' + tone, x: String(labelX), y: String(labelY) }, edge.label),
      );
    }
  }

  for (const [i, step] of workflow.steps.entries()) {
    const result = byId.get(step.id);
    const y = PAD + i * ROW;
    const tone = result
      ? result.status === 'ok' || result.status.startsWith('branch')
        ? 'ok'
        : result.status === 'skipped'
          ? 'skipped'
          : 'failed'
      : step.kind;

    const group = svg('g', {
      class: `flow-node flow-node-${tone}${graph.unreachable.includes(step.id) ? ' flow-node-orphan' : ''}`,
      transform: `translate(0, ${y})`,
    });
    group.appendChild(
      svg(
        'title',
        null,
        [step.name ?? step.id, step.tool ?? step.resource ?? step.prompt, step.notes]
          .filter(Boolean)
          .join(' — '),
      ),
    );
    group.appendChild(
      svg('rect', { class: 'flow-node-box', width: String(NODE_W), height: String(NODE_H), rx: '5' }),
    );
    group.appendChild(
      svg('text', { class: 'flow-node-glyph', x: '12', y: String(NODE_H / 2 + 4) }, glyphFor(step, result)),
    );
    group.appendChild(
      svg(
        'text',
        { class: 'flow-node-label', x: '32', y: String(NODE_H / 2 + 4) },
        truncateLabel(step.name ?? step.tool ?? step.resource ?? step.prompt ?? step.id, 26),
      ),
    );
    if (step.continueOnError) {
      group.appendChild(
        svg(
          'text',
          { class: 'flow-node-sub', x: String(NODE_W - 8), y: String(NODE_H / 2 + 4), 'text-anchor': 'end' },
          'continues',
        ),
      );
    }
    canvas.appendChild(group);
  }

  const wrap = h('div', { class: 'flow-canvas-wrap' }, canvas as unknown as HTMLElement);

  if (graph.dangling.length || graph.unreachable.length) {
    wrap.appendChild(
      h(
        'div',
        { class: 'flow-warnings small' },
        graph.dangling.length
          ? h('span', { class: 'badge badge-error' }, `points at missing: ${graph.dangling.join(', ')}`)
          : null,
        graph.unreachable.length
          ? h('span', { class: 'badge badge-warn' }, `never reached: ${graph.unreachable.join(', ')}`)
          : null,
      ),
    );
  }

  return wrap;
}

function truncateLabel(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
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
