import { Emitter } from './events';
import type { ExecutionService } from './execution';
import type { HistoryEntry } from './history';
import { evaluate, resolvePath, type TestAssertion } from './testing';

/**
 * Workflows: a sequence of MCP calls where each step can read what earlier
 * steps returned. This is what turns a set of tools into something that answers
 * a real question ("is the QC deployment healthy?") rather than one call at a time.
 *
 * Values flow through `{{steps.<id>.output.<path>}}` templates, which is the
 * declarative form of the visual "getUser.id → getEntitlement.userId" mapping.
 */

export type StepKind = 'tool' | 'resource' | 'prompt' | 'branch' | 'note';

export interface WorkflowStep {
  id: string;
  name?: string;
  kind: StepKind;

  /** Server name or id; defaults to the run's server. */
  server?: string;
  tool?: string;
  resource?: string;
  prompt?: string;
  /** May contain `{{steps.…}}` templates. */
  input?: unknown;

  /** For `branch`: evaluated against the referenced step's output. */
  condition?: TestAssertion;
  onTrue?: string;
  onFalse?: string;

  /**
   * Default successor. Omit to fall through to the next step in declaration
   * order - except inside a branch arm, where a step with no `next` ends the run
   * so one arm cannot run into the other.
   */
  next?: string;
  /** Keep going when this step fails. */
  continueOnError?: boolean;
  notes?: string;
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  server?: string;
  steps: WorkflowStep[];
  sourceUri?: string;
}

export type EdgeLabel = 'true' | 'false' | 'next' | 'then';

export interface WorkflowEdge {
  from: string;
  to: string;
  label: EdgeLabel;
}

export interface WorkflowGraph {
  edges: WorkflowEdge[];
  /** Steps nothing points at, other than the first - usually a typo in `next`. */
  unreachable: string[];
  /** Targets named by a step that no step declares. */
  dangling: string[];
}

/**
 * The successor graph, derived by the same rules the runner follows.
 *
 * It has to be derived rather than drawn by eye, because the rules are not
 * obvious: a branch goes to one of two arms, an explicit `next` wins, and
 * otherwise a step falls through to the one after it in declaration order -
 * *except* once a branch has been taken, where a step with no `next` ends the
 * run so one arm cannot run into the other. A picture that disagreed with that
 * would be worse than no picture, so both read from here.
 */
export function buildWorkflowGraph(workflow: Workflow): WorkflowGraph {
  const ids = new Set(workflow.steps.map((step) => step.id));
  const edges: WorkflowEdge[] = [];
  const dangling: string[] = [];

  const target = (to: string | undefined): string | undefined => {
    if (!to) return undefined;
    if (!ids.has(to)) {
      if (!dangling.includes(to)) dangling.push(to);
      return undefined;
    }
    return to;
  };

  // Fall-through only applies before the first branch, mirroring the runner's
  // `branched` flag, which is set once and never cleared.
  const firstBranch = workflow.steps.findIndex((step) => step.kind === 'branch');

  workflow.steps.forEach((step, index) => {
    if (step.kind === 'branch') {
      const onTrue = target(step.onTrue);
      const onFalse = target(step.onFalse);
      if (onTrue) edges.push({ from: step.id, to: onTrue, label: 'true' });
      if (onFalse) edges.push({ from: step.id, to: onFalse, label: 'false' });
      return;
    }

    if (step.next !== undefined) {
      const next = target(step.next);
      if (next) edges.push({ from: step.id, to: next, label: 'next' });
      return;
    }

    if (firstBranch !== -1 && index > firstBranch) {
      return; // inside an arm: no `next` means the run ends here
    }

    const following = workflow.steps[index + 1];
    if (following) {
      edges.push({ from: step.id, to: following.id, label: 'then' });
    }
  });

  const pointedAt = new Set(edges.map((edge) => edge.to));
  const unreachable = workflow.steps
    .slice(1)
    .filter((step) => !pointedAt.has(step.id))
    .map((step) => step.id);

  return { edges, unreachable, dangling };
}

export interface StepResult {
  stepId: string;
  name: string;
  status: 'ok' | 'failed' | 'skipped' | 'branch-true' | 'branch-false';
  durationMs: number;
  input?: unknown;
  output?: unknown;
  error?: string;
  entry?: HistoryEntry;
}

export interface WorkflowRun {
  workflowId: string;
  startedAt: number;
  durationMs: number;
  status: 'completed' | 'failed' | 'cancelled';
  steps: StepResult[];
}

export class UnresolvedReference extends Error {
  constructor(reference: string) {
    super(`Cannot resolve "${reference}": no such step output (yet)`);
    this.name = 'UnresolvedReference';
  }
}

const TEMPLATE = /\{\{\s*([^}]+?)\s*\}\}/g;
const MAX_STEPS = 200;

export class WorkflowRunner {
  private readonly stepDone = new Emitter<StepResult>();
  readonly onDidCompleteStep = this.stepDone.on.bind(this.stepDone);

  constructor(
    private readonly execution: ExecutionService,
    /** Maps a server name from a workflow to a connected server id. */
    private readonly resolveServer: (name: string | undefined) => string | undefined,
  ) {}

  async run(
    workflow: Workflow,
    options: { signal?: { aborted: boolean }; environment?: string } = {},
  ): Promise<WorkflowRun> {
    const startedAt = Date.now();
    const results: StepResult[] = [];
    // Outputs are keyed by step id so templates can reach any earlier step.
    const outputs = new Map<string, unknown>();

    const byId = new Map(workflow.steps.map((step) => [step.id, step]));
    let cursor: WorkflowStep | undefined = workflow.steps[0];
    let guard = 0;
    let status: WorkflowRun['status'] = 'completed';
    // Once a branch is taken, declaration order stops being a successor:
    // otherwise the end of the "true" arm would fall straight into the "false"
    // arm. Inside a branch, a step continues only where it says to.
    let branched = false;

    while (cursor) {
      if (options.signal?.aborted) {
        status = 'cancelled';
        break;
      }
      if (++guard > MAX_STEPS) {
        // A workflow that loops forever is a bug, not a feature.
        results.push({
          stepId: cursor.id,
          name: label(cursor),
          status: 'failed',
          durationMs: 0,
          error: `Workflow exceeded ${MAX_STEPS} steps; check for a cycle.`,
        });
        status = 'failed';
        break;
      }

      const result = await this.runStep(cursor, workflow, outputs, options.environment);
      results.push(result);
      this.stepDone.fire(result);

      if (result.status === 'ok' || result.status?.startsWith('branch')) {
        outputs.set(cursor.id, result.output);
      }

      if (result.status === 'failed' && !cursor.continueOnError) {
        status = 'failed';
        break;
      }

      if (cursor.kind === 'branch') {
        branched = true;
      }
      cursor = this.nextStep(cursor, workflow, byId, result, branched);
    }

    return {
      workflowId: workflow.id,
      startedAt,
      durationMs: Date.now() - startedAt,
      status,
      steps: results,
    };
  }

  private nextStep(
    current: WorkflowStep,
    workflow: Workflow,
    byId: Map<string, WorkflowStep>,
    result: StepResult,
    branched: boolean,
  ): WorkflowStep | undefined {
    if (current.kind === 'branch') {
      const target = result.status === 'branch-true' ? current.onTrue : current.onFalse;
      return target ? byId.get(target) : undefined;
    }
    if (current.next) {
      return byId.get(current.next);
    }
    if (branched) {
      // A branch arm ends where it stops pointing forward.
      return undefined;
    }
    const index = workflow.steps.findIndex((step) => step.id === current.id);
    return workflow.steps[index + 1];
  }

  private async runStep(
    step: WorkflowStep,
    workflow: Workflow,
    outputs: Map<string, unknown>,
    environment?: string,
  ): Promise<StepResult> {
    const started = Date.now();
    const base = { stepId: step.id, name: label(step) };

    if (step.kind === 'note') {
      return { ...base, status: 'skipped', durationMs: 0 };
    }

    if (step.kind === 'branch') {
      if (!step.condition) {
        return {
          ...base,
          status: 'failed',
          durationMs: 0,
          error: 'Branch step has no condition',
        };
      }
      // A branch reads the output its condition path points at.
      const source = step.input ? resolveTemplates(step.input, outputs) : undefined;
      const subject = source ?? Object.fromEntries(outputs);
      const outcome = evaluate(step.condition, subject);
      return {
        ...base,
        status: outcome.passed ? 'branch-true' : 'branch-false',
        durationMs: Date.now() - started,
        input: step.condition,
        output: outcome.actual,
      };
    }

    let input: unknown;
    try {
      input = resolveTemplates(step.input ?? {}, outputs);
    } catch (err) {
      return {
        ...base,
        status: 'failed',
        durationMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const serverId = this.resolveServer(step.server ?? workflow.server);
    if (!serverId) {
      return {
        ...base,
        status: 'failed',
        durationMs: Date.now() - started,
        input,
        error: `No connected server for "${step.server ?? workflow.server ?? 'default'}"`,
      };
    }

    try {
      const outcome =
        step.kind === 'tool'
          ? await this.execution.callTool(serverId, step.tool!, input, {
              skipValidation: true,
              prune: false,
              environment,
            })
          : step.kind === 'resource'
            ? await this.execution.readResource(serverId, String(step.resource), { environment })
            : await this.execution.getPrompt(
                serverId,
                String(step.prompt),
                (input ?? {}) as Record<string, string>,
                { environment },
              );

      if (outcome.entry.error) {
        return {
          ...base,
          status: 'failed',
          durationMs: Date.now() - started,
          input,
          error: outcome.entry.error.message,
          entry: outcome.entry,
        };
      }

      return {
        ...base,
        status: 'ok',
        durationMs: Date.now() - started,
        input,
        output: outcome.entry.output,
        entry: outcome.entry,
      };
    } catch (err) {
      return {
        ...base,
        status: 'failed',
        durationMs: Date.now() - started,
        input,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/**
 * Substitutes `{{steps.<id>.output.<path>}}` references. A string that is
 * exactly one reference keeps the referenced value's type; a reference inside
 * a longer string is interpolated as text.
 */
export function resolveTemplates(value: unknown, outputs: Map<string, unknown>): unknown {
  if (typeof value === 'string') {
    const whole = value.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
    if (whole) {
      return lookup(whole[1], outputs);
    }
    return value.replace(TEMPLATE, (_match, reference: string) => {
      const resolved = lookup(reference, outputs);
      return typeof resolved === 'string' ? resolved : JSON.stringify(resolved ?? null);
    });
  }

  if (Array.isArray(value)) {
    return value.map((entry) => resolveTemplates(entry, outputs));
  }

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = resolveTemplates(entry, outputs);
    }
    return out;
  }

  return value;
}

function lookup(reference: string, outputs: Map<string, unknown>): unknown {
  const trimmed = reference.trim();
  const match = trimmed.match(/^steps\.([^.]+)\.output(?:\.(.*))?$/);
  if (!match) {
    throw new UnresolvedReference(trimmed);
  }
  const [, stepId, path] = match;
  if (!outputs.has(stepId)) {
    throw new UnresolvedReference(trimmed);
  }
  const output = outputs.get(stepId);
  return path ? resolvePath(output, `$.${path}`) : output;
}

/** Every `{{steps.x.output…}}` reference a workflow makes, for validation. */
export function referencedSteps(workflow: Workflow): Map<string, string[]> {
  const references = new Map<string, string[]>();

  const visit = (stepId: string, value: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(TEMPLATE)) {
        const reference = match[1].trim().match(/^steps\.([^.]+)\./);
        if (reference) {
          const list = references.get(stepId) ?? [];
          list.push(reference[1]);
          references.set(stepId, list);
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry) => visit(stepId, entry));
      return;
    }
    if (value && typeof value === 'object') {
      Object.values(value as Record<string, unknown>).forEach((entry) => visit(stepId, entry));
    }
  };

  for (const step of workflow.steps) {
    visit(step.id, step.input);
  }
  return references;
}

/** Structural problems that would make a run fail, found before running it. */
export function validateWorkflow(workflow: Workflow): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();

  for (const step of workflow.steps) {
    if (ids.has(step.id)) {
      problems.push(`Duplicate step id "${step.id}"`);
    }
    ids.add(step.id);

    if (step.kind === 'tool' && !step.tool) {
      problems.push(`Step "${step.id}" is a tool step with no tool name`);
    }
    if (step.kind === 'branch' && !step.condition) {
      problems.push(`Step "${step.id}" is a branch with no condition`);
    }
  }

  for (const step of workflow.steps) {
    for (const target of [step.next, step.onTrue, step.onFalse]) {
      if (target && !ids.has(target)) {
        problems.push(`Step "${step.id}" points at unknown step "${target}"`);
      }
    }
  }

  // A step may only read outputs from steps declared before it.
  const order = new Map(workflow.steps.map((step, index) => [step.id, index]));
  for (const [stepId, referenced] of referencedSteps(workflow)) {
    for (const reference of referenced) {
      if (!ids.has(reference)) {
        problems.push(`Step "${stepId}" references unknown step "${reference}"`);
      } else if ((order.get(reference) ?? 0) >= (order.get(stepId) ?? 0)) {
        problems.push(
          `Step "${stepId}" references "${reference}", which does not run before it`,
        );
      }
    }
  }

  return problems;
}

/**
 * Turns a recorded sequence of invocations into a workflow, wiring each step's
 * input to earlier outputs where a value obviously came from one.
 */
export function workflowFromHistory(
  entries: HistoryEntry[],
  name: string,
): Workflow {
  const steps: WorkflowStep[] = [];
  const produced: Array<{ stepId: string; path: string; value: unknown }> = [];

  for (const [index, entry] of entries.entries()) {
    const stepId = `${sanitize(entry.name)}_${index + 1}`;
    const input = link(entry.input, produced);

    steps.push({
      id: stepId,
      name: entry.name,
      kind: entry.kind,
      server: entry.serverName,
      ...(entry.kind === 'tool'
        ? { tool: entry.name }
        : entry.kind === 'resource'
          ? { resource: entry.name }
          : { prompt: entry.name }),
      input,
    });

    collectScalars(entry.output, '', (path, value) => {
      produced.push({ stepId, path, value });
    });
  }

  return {
    id: sanitize(name),
    name,
    description: `Recorded from ${entries.length} invocation(s).`,
    steps,
  };
}

/** Replaces literal values that match an earlier output with a template. */
function link(
  input: unknown,
  produced: Array<{ stepId: string; path: string; value: unknown }>,
): unknown {
  if (input === null || input === undefined) {
    return input;
  }

  if (typeof input === 'string' || typeof input === 'number') {
    const source = produced.find((candidate) => candidate.value === input);
    return source ? `{{steps.${source.stepId}.output.${source.path}}}` : input;
  }

  if (Array.isArray(input)) {
    return input.map((entry) => link(entry, produced));
  }

  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      out[key] = link(value, produced);
    }
    return out;
  }

  return input;
}

function collectScalars(
  value: unknown,
  path: string,
  visit: (path: string, value: unknown) => void,
  depth = 0,
): void {
  if (depth > 6 || value === null || value === undefined) {
    return;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    if (path) {
      visit(path, value);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      collectScalars(entry, `${path}[${index}]`, visit, depth + 1),
    );
    return;
  }
  if (typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      collectScalars(entry, path ? `${path}.${key}` : key, visit, depth + 1);
    }
  }
}

function label(step: WorkflowStep): string {
  return step.name ?? step.tool ?? step.resource ?? step.prompt ?? step.id;
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'step';
}
