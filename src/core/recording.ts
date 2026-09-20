import { Emitter } from './events';
import type { ExecutionService } from './execution';
import type { HistoryEntry } from './history';
import type { Disposable } from './events';
import type { TestCase } from './testing';
import { workflowFromHistory, type Workflow } from './workflows';

/**
 * Records the invocations that happen while it is armed, so a debugging session
 * can be turned into a workflow or a regression suite without retyping anything.
 *
 * It listens to ExecutionService rather than to the UI, which means calls made
 * by tests, replays or the AI bridge are captured too.
 */
export class Recorder {
  private entries: HistoryEntry[] = [];
  private subscription?: Disposable;
  private startedAt?: number;

  private readonly changed = new Emitter<HistoryEntry[]>();
  readonly onDidChange = this.changed.on.bind(this.changed);

  constructor(private readonly execution: ExecutionService) {}

  get isRecording(): boolean {
    return !!this.subscription;
  }

  get recorded(): HistoryEntry[] {
    return [...this.entries];
  }

  get elapsedMs(): number {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }

  start(filter?: { serverId?: string }): void {
    if (this.subscription) {
      return;
    }
    this.entries = [];
    this.startedAt = Date.now();
    this.subscription = this.execution.onDidExecute((entry) => {
      if (filter?.serverId && entry.serverId !== filter.serverId) {
        return;
      }
      this.entries.push(entry);
      this.changed.fire(this.recorded);
    });
  }

  stop(): HistoryEntry[] {
    this.subscription?.dispose();
    this.subscription = undefined;
    return this.recorded;
  }

  clear(): void {
    this.entries = [];
    this.changed.fire([]);
  }

  /** Drops one entry, for pruning a mis-step out of a recording. */
  remove(id: string): void {
    this.entries = this.entries.filter((entry) => entry.id !== id);
    this.changed.fire(this.recorded);
  }

  toWorkflow(name: string): Workflow {
    if (this.entries.length === 0) {
      throw new Error('Nothing was recorded.');
    }
    return workflowFromHistory(this.entries, name);
  }

  /**
   * Turns the recording into tests. Successful calls assert the response shape
   * rather than exact values, so a recorded suite does not break on a timestamp.
   */
  toTests(): TestCase[] {
    return this.entries.map((entry, index) => {
      const target =
        entry.kind === 'tool'
          ? { tool: entry.name }
          : entry.kind === 'resource'
            ? { resource: entry.name }
            : { prompt: entry.name };

      if (entry.error) {
        return {
          name: `${entry.name} fails as recorded (#${index + 1})`,
          ...target,
          input: entry.input,
          expectError: { code: entry.error.code },
        } as TestCase;
      }

      return {
        name: `${entry.name} succeeds as recorded (#${index + 1})`,
        ...target,
        input: entry.input,
        assertions: shapeAssertions(entry.output),
      } as TestCase;
    });
  }

  /** Re-runs the recorded calls in order, exactly as they were sent. */
  async replayAll(
    options: { onStep?: (entry: HistoryEntry, index: number) => void } = {},
  ): Promise<HistoryEntry[]> {
    const replayed: HistoryEntry[] = [];
    // Iterate a snapshot: replaying appends to history, which would otherwise grow forever.
    for (const [index, entry] of this.recorded.entries()) {
      const outcome = await this.execution.replay(entry.id);
      replayed.push(outcome.entry);
      options.onStep?.(outcome.entry, index);
    }
    return replayed;
  }

  dispose(): void {
    this.stop();
    this.changed.dispose();
  }
}

function shapeAssertions(output: unknown): TestCase['assertions'] {
  const assertions: NonNullable<TestCase['assertions']> = [
    { path: '$.isError', notEquals: true },
  ];
  const result = output as { structuredContent?: unknown; content?: unknown[] } | undefined;

  if (result?.structuredContent && typeof result.structuredContent === 'object') {
    for (const [key, value] of Object.entries(result.structuredContent as Record<string, unknown>)) {
      assertions.push({
        path: `$.structuredContent.${key}`,
        type: Array.isArray(value)
          ? 'array'
          : value === null
            ? 'null'
            : (typeof value as 'string' | 'number' | 'boolean' | 'object'),
      });
    }
  } else if (Array.isArray(result?.content) && result.content.length > 0) {
    assertions.push({ path: '$.content[0].type', exists: true });
  }

  return assertions;
}
