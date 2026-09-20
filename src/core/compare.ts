import type { Implementation, JsonSchema, Prompt, Resource, Tool } from './protocol';
import { normalizeSchema, type FieldSpec } from './schema';

/**
 * Diffs two servers - typically the same server in two environments. The point
 * is to catch a DEV/QC drift before it reaches production, so the comparison is
 * about *contract* differences, not cosmetic ones.
 */

export interface CompareSide {
  label: string;
  serverInfo?: Implementation;
  protocolVersion?: string;
  tools: Tool[];
  resources: Resource[];
  prompts: Prompt[];
}

export type DiffKind = 'only-left' | 'only-right' | 'changed';

export interface SchemaDifference {
  path: string;
  left?: string;
  right?: string;
  /** True when the change can break an existing caller. */
  breaking: boolean;
  message: string;
}

export interface ToolDiff {
  name: string;
  kind: DiffKind;
  differences: SchemaDifference[];
}

export interface CompareResult {
  left: string;
  right: string;
  versions: { left?: string; right?: string };
  protocols: { left?: string; right?: string };
  counts: {
    tools: [number, number];
    resources: [number, number];
    prompts: [number, number];
  };
  tools: ToolDiff[];
  resources: Array<{ uri: string; kind: DiffKind }>;
  prompts: Array<{ name: string; kind: DiffKind }>;
  breakingCount: number;
}

export function compareServers(left: CompareSide, right: CompareSide): CompareResult {
  const tools: ToolDiff[] = [];

  const leftTools = new Map(left.tools.map((t) => [t.name, t]));
  const rightTools = new Map(right.tools.map((t) => [t.name, t]));

  for (const [name, tool] of leftTools) {
    const other = rightTools.get(name);
    if (!other) {
      tools.push({ name, kind: 'only-left', differences: [] });
      continue;
    }
    const differences = diffTool(tool, other);
    if (differences.length > 0) {
      tools.push({ name, kind: 'changed', differences });
    }
  }
  for (const name of rightTools.keys()) {
    if (!leftTools.has(name)) {
      tools.push({ name, kind: 'only-right', differences: [] });
    }
  }

  const resources = diffNames(
    left.resources.map((r) => r.uri),
    right.resources.map((r) => r.uri),
  ).map(({ name, kind }) => ({ uri: name, kind }));

  const prompts = diffNames(
    left.prompts.map((p) => p.name),
    right.prompts.map((p) => p.name),
  );

  const breakingCount =
    tools.filter((t) => t.kind === 'only-left').length +
    tools.reduce((sum, t) => sum + t.differences.filter((d) => d.breaking).length, 0) +
    resources.filter((r) => r.kind === 'only-left').length +
    prompts.filter((p) => p.kind === 'only-left').length;

  return {
    left: left.label,
    right: right.label,
    versions: { left: left.serverInfo?.version, right: right.serverInfo?.version },
    protocols: { left: left.protocolVersion, right: right.protocolVersion },
    counts: {
      tools: [left.tools.length, right.tools.length],
      resources: [left.resources.length, right.resources.length],
      prompts: [left.prompts.length, right.prompts.length],
    },
    tools: tools.sort((a, b) => a.name.localeCompare(b.name)),
    resources,
    prompts,
    breakingCount,
  };
}

function diffNames(
  left: string[],
  right: string[],
): Array<{ name: string; kind: DiffKind }> {
  const rightSet = new Set(right);
  const leftSet = new Set(left);
  const out: Array<{ name: string; kind: DiffKind }> = [];

  for (const name of left) {
    if (!rightSet.has(name)) {
      out.push({ name, kind: 'only-left' });
    }
  }
  for (const name of right) {
    if (!leftSet.has(name)) {
      out.push({ name, kind: 'only-right' });
    }
  }
  return out;
}

function diffTool(left: Tool, right: Tool): SchemaDifference[] {
  const differences: SchemaDifference[] = [];

  if ((left.description ?? '') !== (right.description ?? '')) {
    differences.push({
      path: 'description',
      left: firstLine(left.description),
      right: firstLine(right.description),
      breaking: false,
      message: 'Description differs',
    });
  }

  for (const key of ['destructiveHint', 'readOnlyHint', 'idempotentHint'] as const) {
    const a = left.annotations?.[key];
    const b = right.annotations?.[key];
    if (a !== b) {
      differences.push({
        path: `annotations.${key}`,
        left: String(a),
        right: String(b),
        // Losing a destructive hint means clients stop asking for confirmation.
        breaking: key === 'destructiveHint' && a === true && b !== true,
        message: `Annotation ${key} changed`,
      });
    }
  }

  differences.push(
    ...diffSchema(normalizeSchema(left.inputSchema), normalizeSchema(right.inputSchema), 'input'),
  );

  if (left.outputSchema || right.outputSchema) {
    if (!!left.outputSchema !== !!right.outputSchema) {
      differences.push({
        path: 'outputSchema',
        left: left.outputSchema ? 'declared' : 'absent',
        right: right.outputSchema ? 'declared' : 'absent',
        breaking: !!left.outputSchema && !right.outputSchema,
        message: 'Output schema presence differs',
      });
    } else if (left.outputSchema && right.outputSchema) {
      differences.push(
        ...diffSchema(
          normalizeSchema(left.outputSchema),
          normalizeSchema(right.outputSchema),
          'output',
        ),
      );
    }
  }

  return differences;
}

function diffSchema(left: FieldSpec, right: FieldSpec, prefix: string): SchemaDifference[] {
  const differences: SchemaDifference[] = [];

  const leftChildren = new Map((left.children ?? []).map((c) => [c.name, c]));
  const rightChildren = new Map((right.children ?? []).map((c) => [c.name, c]));

  for (const [name, child] of leftChildren) {
    const other = rightChildren.get(name);
    if (!other) {
      differences.push({
        path: `${prefix}.${name}`,
        left: typeLabel(child),
        breaking: true,
        message: `Parameter "${name}" was removed`,
      });
      continue;
    }

    if (child.kind !== other.kind) {
      differences.push({
        path: `${prefix}.${name}`,
        left: child.kind,
        right: other.kind,
        breaking: true,
        message: `Type of "${name}" changed`,
      });
    }

    if (child.required !== other.required) {
      differences.push({
        path: `${prefix}.${name}`,
        left: child.required ? 'required' : 'optional',
        right: other.required ? 'required' : 'optional',
        // Newly required parameters break every existing caller.
        breaking: !child.required && other.required,
        message: `"${name}" changed from ${child.required ? 'required' : 'optional'} to ${
          other.required ? 'required' : 'optional'
        }`,
      });
    }

    if (child.kind === 'enum') {
      const before = new Set((child.enumValues ?? []).map(String));
      const after = new Set((other.enumValues ?? []).map(String));
      const removed = [...before].filter((v) => !after.has(v));
      const added = [...after].filter((v) => !before.has(v));
      if (removed.length || added.length) {
        differences.push({
          path: `${prefix}.${name}`,
          left: [...before].join(', '),
          right: [...after].join(', '),
          breaking: removed.length > 0,
          message: `Enum values changed${removed.length ? ` (removed: ${removed.join(', ')})` : ''}`,
        });
      }
    }

    if (child.kind === 'object') {
      differences.push(...diffSchema(child, other, `${prefix}.${name}`));
    }
  }

  for (const [name, child] of rightChildren) {
    if (!leftChildren.has(name)) {
      differences.push({
        path: `${prefix}.${name}`,
        right: typeLabel(child),
        breaking: child.required,
        message: `Parameter "${name}" was added${child.required ? ' as required' : ''}`,
      });
    }
  }

  return differences;
}

function typeLabel(spec: FieldSpec): string {
  return spec.required ? `${spec.kind} (required)` : spec.kind;
}

function firstLine(value?: string): string | undefined {
  return value?.split('\n')[0].trim();
}

/** Compares the raw schemas, for callers that only need a yes/no. */
export function schemasEqual(a: JsonSchema | undefined, b: JsonSchema | undefined): boolean {
  return JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
}
