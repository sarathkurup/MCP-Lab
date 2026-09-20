import type { JsonSchema } from './protocol';

/**
 * JSON Schema -> form model. The UI must never hardcode a field: every input it
 * draws comes from normalizing a tool's declared schema into these specs.
 */

export type FieldKind =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'enum'
  | 'array'
  | 'object'
  | 'unknown';

export interface FieldSpec {
  /** Dot/bracket path from the root value, e.g. `filters.tags[0]`. */
  path: string;
  /** Property name at this level, empty for the root. */
  name: string;
  label: string;
  kind: FieldKind;
  schema: JsonSchema;
  required: boolean;
  description?: string;
  defaultValue?: unknown;
  enumValues?: unknown[];
  nullable: boolean;
  /** Present for kind === 'object'. */
  children?: FieldSpec[];
  /** Present for kind === 'array': the spec describing one item. */
  item?: FieldSpec;
  format?: string;
  constraints: Constraints;
}

export interface Constraints {
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

export interface ValidationError {
  path: string;
  message: string;
}

const MAX_DEPTH = 8;

export function normalizeSchema(
  schema: JsonSchema | undefined,
  options: { path?: string; name?: string; required?: boolean; depth?: number } = {},
): FieldSpec {
  const depth = options.depth ?? 0;
  const path = options.path ?? '';
  const name = options.name ?? '';
  const resolved = collapseCompositions(schema ?? {});
  const { kind, nullable } = classify(resolved);

  const spec: FieldSpec = {
    path,
    name,
    label: resolved.title ?? humanize(name) ?? 'value',
    kind,
    schema: resolved,
    required: options.required ?? false,
    description: resolved.description,
    defaultValue: resolved.default,
    enumValues: resolved.enum,
    nullable,
    format: resolved.format,
    constraints: {
      minimum: numberOrUndefined(resolved.minimum),
      maximum: numberOrUndefined(resolved.maximum),
      minLength: numberOrUndefined(resolved.minLength),
      maxLength: numberOrUndefined(resolved.maxLength),
      pattern: typeof resolved.pattern === 'string' ? resolved.pattern : undefined,
    },
  };

  if (depth >= MAX_DEPTH) {
    // Deeply recursive schemas are edited as raw JSON rather than nested forms.
    spec.kind = 'unknown';
    return spec;
  }

  if (kind === 'object') {
    const properties = resolved.properties ?? {};
    const requiredNames = new Set(resolved.required ?? []);
    spec.children = Object.entries(properties).map(([key, child]) =>
      normalizeSchema(child, {
        path: path ? `${path}.${key}` : key,
        name: key,
        required: requiredNames.has(key),
        depth: depth + 1,
      }),
    );
  }

  if (kind === 'array') {
    const items = Array.isArray(resolved.items) ? resolved.items[0] : resolved.items;
    spec.item = normalizeSchema(items ?? {}, {
      path: `${path}[]`,
      name: 'item',
      required: true,
      depth: depth + 1,
    });
  }

  return spec;
}

/**
 * Best-effort flattening of anyOf/oneOf/allOf. `["string", "null"]` and
 * `anyOf: [T, null]` are the shapes servers actually emit for optional values.
 */
function collapseCompositions(schema: JsonSchema): JsonSchema {
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    const merged: JsonSchema = { ...schema };
    delete merged.allOf;
    for (const part of schema.allOf) {
      Object.assign(merged, part, {
        properties: { ...(merged.properties ?? {}), ...(part.properties ?? {}) },
        required: [...(merged.required ?? []), ...(part.required ?? [])],
      });
    }
    return merged;
  }

  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union) && union.length > 0) {
    const nonNull = union.filter((s) => s.type !== 'null');
    const base = nonNull[0] ?? union[0];
    const merged: JsonSchema = { ...base };
    if (schema.description && !merged.description) {
      merged.description = schema.description;
    }
    if (schema.title && !merged.title) {
      merged.title = schema.title;
    }
    if (schema.default !== undefined && merged.default === undefined) {
      merged.default = schema.default;
    }
    if (nonNull.length < union.length) {
      merged.type = Array.isArray(merged.type)
        ? [...merged.type, 'null']
        : [String(merged.type ?? 'string'), 'null'];
    }
    return merged;
  }

  return schema;
}

function classify(schema: JsonSchema): { kind: FieldKind; nullable: boolean } {
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const nullable = types.includes('null');
  const primary = types.find((t) => t !== 'null');

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return { kind: 'enum', nullable };
  }
  if (schema.const !== undefined) {
    return { kind: 'enum', nullable };
  }

  switch (primary) {
    case 'string':
      return { kind: 'string', nullable };
    case 'number':
      return { kind: 'number', nullable };
    case 'integer':
      return { kind: 'integer', nullable };
    case 'boolean':
      return { kind: 'boolean', nullable };
    case 'array':
      return { kind: 'array', nullable };
    case 'object':
      return { kind: 'object', nullable };
    default:
      break;
  }

  // Untyped schemas are still usable when they describe properties or items.
  if (schema.properties) {
    return { kind: 'object', nullable };
  }
  if (schema.items) {
    return { kind: 'array', nullable };
  }
  return { kind: 'unknown', nullable };
}

/** A starting value for a form: declared defaults, then empty containers. */
export function defaultsFor(spec: FieldSpec): unknown {
  if (spec.defaultValue !== undefined) {
    return structuredCloneSafe(spec.defaultValue);
  }
  switch (spec.kind) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const child of spec.children ?? []) {
        // Only seed required children, so optional fields are genuinely absent.
        if (child.required || child.defaultValue !== undefined) {
          out[child.name] = defaultsFor(child);
        }
      }
      return out;
    }
    case 'array':
      return [];
    case 'boolean':
      return false;
    case 'enum':
      return spec.schema.const !== undefined ? spec.schema.const : (spec.enumValues?.[0] ?? null);
    case 'string':
      return '';
    case 'number':
    case 'integer':
      return null;
    default:
      return null;
  }
}

/**
 * Validates a value against a normalized spec. This runs before every tool call
 * so a malformed request is caught in Workbench rather than on the server.
 */
export function validateValue(spec: FieldSpec, value: unknown): ValidationError[] {
  const errors: ValidationError[] = [];
  walk(spec, value, errors);
  return errors;
}

function walk(spec: FieldSpec, value: unknown, errors: ValidationError[]): void {
  const label = spec.path || 'value';

  if (value === null || value === undefined) {
    if (spec.required && !spec.nullable) {
      errors.push({ path: label, message: `${spec.name || 'value'} is required` });
    }
    return;
  }

  switch (spec.kind) {
    case 'string': {
      if (typeof value !== 'string') {
        errors.push({ path: label, message: 'Expected a string' });
        return;
      }
      if (spec.required && value.trim() === '') {
        errors.push({ path: label, message: `${spec.name || 'value'} is required` });
      }
      const { minLength, maxLength, pattern } = spec.constraints;
      if (minLength !== undefined && value.length < minLength) {
        errors.push({ path: label, message: `Must be at least ${minLength} characters` });
      }
      if (maxLength !== undefined && value.length > maxLength) {
        errors.push({ path: label, message: `Must be at most ${maxLength} characters` });
      }
      if (pattern) {
        try {
          if (!new RegExp(pattern).test(value)) {
            errors.push({ path: label, message: `Must match ${pattern}` });
          }
        } catch {
          // An unparsable server-side pattern is not the user's problem.
        }
      }
      if (spec.format && !checkFormat(spec.format, value)) {
        errors.push({ path: label, message: `Must be a valid ${spec.format}` });
      }
      return;
    }

    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        errors.push({ path: label, message: 'Expected a number' });
        return;
      }
      if (spec.kind === 'integer' && !Number.isInteger(value)) {
        errors.push({ path: label, message: 'Expected a whole number' });
      }
      const { minimum, maximum } = spec.constraints;
      if (minimum !== undefined && value < minimum) {
        errors.push({ path: label, message: `Must be >= ${minimum}` });
      }
      if (maximum !== undefined && value > maximum) {
        errors.push({ path: label, message: `Must be <= ${maximum}` });
      }
      return;
    }

    case 'boolean':
      if (typeof value !== 'boolean') {
        errors.push({ path: label, message: 'Expected true or false' });
      }
      return;

    case 'enum': {
      const allowed = spec.enumValues ?? (spec.schema.const !== undefined ? [spec.schema.const] : []);
      if (allowed.length > 0 && !allowed.some((a) => deepEqual(a, value))) {
        errors.push({
          path: label,
          message: `Must be one of: ${allowed.map((a) => JSON.stringify(a)).join(', ')}`,
        });
      }
      return;
    }

    case 'array': {
      if (!Array.isArray(value)) {
        errors.push({ path: label, message: 'Expected an array' });
        return;
      }
      if (spec.item) {
        value.forEach((entry, index) => {
          walk({ ...spec.item!, path: `${label}[${index}]` }, entry, errors);
        });
      }
      return;
    }

    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) {
        errors.push({ path: label, message: 'Expected an object' });
        return;
      }
      const record = value as Record<string, unknown>;
      for (const child of spec.children ?? []) {
        const childValue = record[child.name];
        if (childValue === undefined) {
          if (child.required) {
            errors.push({
              path: child.path,
              message: `${child.name} is required`,
            });
          }
          continue;
        }
        walk(child, childValue, errors);
      }
      if (spec.schema.additionalProperties === false && spec.children) {
        const known = new Set(spec.children.map((c) => c.name));
        for (const key of Object.keys(record)) {
          if (!known.has(key)) {
            errors.push({ path: `${label}.${key}`, message: 'Unexpected property' });
          }
        }
      }
      return;
    }

    default:
      return;
  }
}

function checkFormat(format: string, value: string): boolean {
  switch (format) {
    case 'date-time':
      return !Number.isNaN(Date.parse(value)) && /\d{4}-\d{2}-\d{2}[T ]/.test(value);
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(value);
    case 'time':
      return /^\d{2}:\d{2}(:\d{2})?/.test(value);
    case 'uri':
    case 'url':
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    case 'email':
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
    case 'uuid':
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
    default:
      return true;
  }
}

/**
 * Drops empty optional fields so a request carries only what the user filled in.
 * Servers commonly reject `""` where they would accept an absent property.
 */
export function pruneEmpty(spec: FieldSpec, value: unknown): unknown {
  if (spec.kind === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const child of spec.children ?? []) {
      const childValue = record[child.name];
      if (childValue === undefined) {
        continue;
      }
      if (!child.required && isEmptyValue(child, childValue)) {
        continue;
      }
      out[child.name] = pruneEmpty(child, childValue);
    }
    // Preserve properties the schema did not declare (additionalProperties).
    for (const [key, entry] of Object.entries(record)) {
      if (!(key in out) && !(spec.children ?? []).some((c) => c.name === key)) {
        out[key] = entry;
      }
    }
    return out;
  }

  if (spec.kind === 'array' && Array.isArray(value) && spec.item) {
    return value.map((entry) => pruneEmpty(spec.item!, entry));
  }

  return value;
}

function isEmptyValue(spec: FieldSpec, value: unknown): boolean {
  if (value === null || value === undefined) {
    return true;
  }
  // An unset enum arrives as an empty string from a select, not as undefined.
  if ((spec.kind === 'string' || spec.kind === 'enum') && value === '') {
    return true;
  }
  if (spec.kind === 'array' && Array.isArray(value) && value.length === 0) {
    return true;
  }
  if (
    spec.kind === 'object' &&
    typeof value === 'object' &&
    Object.keys(value as object).length === 0
  ) {
    return true;
  }
  return false;
}

/** Turns a form input string into the type the schema asks for. */
export function coerceInput(spec: FieldSpec, raw: string): unknown {
  switch (spec.kind) {
    case 'number':
    case 'integer': {
      if (raw.trim() === '') {
        return null;
      }
      const parsed = Number(raw);
      return Number.isNaN(parsed) ? raw : parsed;
    }
    case 'boolean':
      return raw === 'true';
    case 'enum': {
      const match = (spec.enumValues ?? []).find((v) => String(v) === raw);
      return match !== undefined ? match : raw;
    }
    default:
      return raw;
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function humanize(name: string): string | undefined {
  if (!name) {
    return undefined;
  }
  return name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^\w/, (c) => c.toUpperCase());
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function structuredCloneSafe<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}
