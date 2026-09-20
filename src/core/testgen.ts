import type { Tool } from './protocol';
import { normalizeSchema, type FieldSpec } from './schema';
import type { TestAssertion, TestCase } from './testing';

/**
 * Derives a test suite from a tool's schema alone.
 *
 * This is deliberately not AI: the schema already states what is required,
 * what the enums are and where the bounds lie, so those cases can be generated
 * exactly and offline. The language model is for the cases a schema cannot
 * express - business rules, realistic values, ordering effects.
 */
export function generateTests(tool: Tool, options: { includeHappyPath?: boolean } = {}): TestCase[] {
  const spec = normalizeSchema(tool.inputSchema);
  const children = spec.children ?? [];
  const cases: TestCase[] = [];

  const happy = sampleObject(spec);

  if (options.includeHappyPath !== false) {
    cases.push({
      name: `${tool.name}: valid input`,
      tool: tool.name,
      input: happy,
      assertions: happyAssertions(tool),
    });
  }

  for (const child of children.filter((c) => c.required)) {
    const input = { ...happy };
    delete input[child.name];
    cases.push({
      name: `${tool.name}: missing required "${child.name}"`,
      tool: tool.name,
      input,
      // A server may reject at the protocol level or return isError; either is
      // a correct refusal, so the assertion only insists that it did not succeed.
      expectError: true,
    });
  }

  for (const child of children) {
    const wrong = wrongTypeFor(child);
    if (wrong === undefined) {
      continue;
    }
    cases.push({
      name: `${tool.name}: "${child.name}" has the wrong type`,
      tool: tool.name,
      input: { ...happy, [child.name]: wrong },
      expectError: true,
    });
  }

  for (const child of children.filter((c) => c.kind === 'enum')) {
    cases.push({
      name: `${tool.name}: "${child.name}" outside its enum`,
      tool: tool.name,
      input: { ...happy, [child.name]: '__not_a_valid_value__' },
      expectError: true,
    });
  }

  for (const child of children) {
    const { minimum, maximum, minLength, maxLength } = child.constraints;
    if (minimum !== undefined) {
      cases.push({
        name: `${tool.name}: "${child.name}" below minimum`,
        tool: tool.name,
        input: { ...happy, [child.name]: minimum - 1 },
        expectError: true,
      });
    }
    if (maximum !== undefined) {
      cases.push({
        name: `${tool.name}: "${child.name}" above maximum`,
        tool: tool.name,
        input: { ...happy, [child.name]: maximum + 1 },
        expectError: true,
      });
    }
    if (minLength !== undefined && minLength > 0) {
      cases.push({
        name: `${tool.name}: "${child.name}" shorter than minLength`,
        tool: tool.name,
        input: { ...happy, [child.name]: 'x'.repeat(Math.max(0, minLength - 1)) },
        expectError: true,
      });
    }
    if (maxLength !== undefined) {
      cases.push({
        name: `${tool.name}: "${child.name}" longer than maxLength`,
        tool: tool.name,
        input: { ...happy, [child.name]: 'x'.repeat(maxLength + 1) },
        expectError: true,
      });
    }
    if (child.format) {
      cases.push({
        name: `${tool.name}: "${child.name}" is not a valid ${child.format}`,
        tool: tool.name,
        input: { ...happy, [child.name]: 'not-a-valid-value' },
        expectError: true,
      });
    }
  }

  if (children.length > 0) {
    cases.push({
      name: `${tool.name}: empty input`,
      tool: tool.name,
      input: {},
      expectError: children.some((c) => c.required),
    });
  }

  return cases;
}

function happyAssertions(tool: Tool): TestAssertion[] {
  const assertions: TestAssertion[] = [{ path: '$.isError', notEquals: true }];

  const output = tool.outputSchema;
  if (output?.properties) {
    // An output schema tells us exactly what a successful call must contain.
    for (const [name, property] of Object.entries(output.properties)) {
      const required = (output.required ?? []).includes(name);
      if (!required) {
        continue;
      }
      assertions.push({
        path: `$.structuredContent.${name}`,
        type: jsonType(property.type),
      });
    }
  } else {
    assertions.push({ path: '$.content', type: 'array' });
  }

  return assertions;
}

function jsonType(type: unknown): TestAssertion['type'] {
  const value = Array.isArray(type) ? type.find((t) => t !== 'null') : type;
  switch (value) {
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array':
      return 'array';
    case 'object':
      return 'object';
    default:
      return 'string';
  }
}

/** A plausible value for every declared property, required or not. */
export function sampleObject(spec: FieldSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const child of spec.children ?? []) {
    const value = sampleValue(child);
    if (value !== undefined) {
      out[child.name] = value;
    }
  }
  return out;
}

function sampleValue(spec: FieldSpec): unknown {
  if (spec.defaultValue !== undefined) {
    return spec.defaultValue;
  }

  switch (spec.kind) {
    case 'enum':
      return spec.enumValues?.[0] ?? spec.schema.const;
    case 'boolean':
      return true;
    case 'integer':
    case 'number': {
      const { minimum, maximum } = spec.constraints;
      if (minimum !== undefined) {
        return minimum;
      }
      if (maximum !== undefined) {
        return maximum;
      }
      return 1;
    }
    case 'string':
      return sampleString(spec);
    case 'array':
      return spec.item ? [sampleValue(spec.item)] : [];
    case 'object':
      return sampleObject(spec);
    default:
      return null;
  }
}

function sampleString(spec: FieldSpec): string {
  switch (spec.format) {
    case 'date-time':
      return '2026-01-01T00:00:00Z';
    case 'date':
      return '2026-01-01';
    case 'time':
      return '09:00:00';
    case 'email':
      return 'test@example.com';
    case 'uri':
    case 'url':
      return 'https://example.com';
    case 'uuid':
      return '00000000-0000-4000-8000-000000000000';
    default:
      break;
  }
  const minLength = spec.constraints.minLength ?? 0;
  const base = `test-${spec.name}`;
  return base.length >= minLength ? base : base.padEnd(minLength, 'x');
}

function wrongTypeFor(spec: FieldSpec): unknown {
  switch (spec.kind) {
    case 'string':
      return 12345;
    case 'number':
    case 'integer':
      return 'not-a-number';
    case 'boolean':
      return 'not-a-boolean';
    case 'array':
      return 'not-an-array';
    case 'object':
      return 'not-an-object';
    default:
      // An enum or untyped field has no unambiguous "wrong type".
      return undefined;
  }
}
