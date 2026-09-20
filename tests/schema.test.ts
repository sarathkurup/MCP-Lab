import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { JsonSchema } from '../src/core/protocol';
import {
  coerceInput,
  defaultsFor,
  normalizeSchema,
  pruneEmpty,
  validateValue,
} from '../src/core/schema';

const EVENT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    eventId: { type: 'string', description: 'Identifier' },
    title: { type: 'string', minLength: 3 },
    enabled: { type: 'boolean', default: true },
    priority: { type: 'integer', minimum: 1, maximum: 5 },
    environment: { type: 'string', enum: ['DEV', 'QC', 'PROD'] },
    startsAt: { type: 'string', format: 'date-time' },
    tags: { type: 'array', items: { type: 'string' } },
    owner: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        email: { type: 'string', format: 'email' },
      },
      required: ['name'],
    },
    notes: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
  required: ['eventId', 'title'],
};

describe('normalizeSchema', () => {
  const spec = normalizeSchema(EVENT_SCHEMA);

  it('produces one field per declared property', () => {
    assert.deepEqual(
      (spec.children ?? []).map((c) => c.name),
      ['eventId', 'title', 'enabled', 'priority', 'environment', 'startsAt', 'tags', 'owner', 'notes'],
    );
  });

  it('classifies each field kind from the schema', () => {
    const kinds = Object.fromEntries((spec.children ?? []).map((c) => [c.name, c.kind]));
    assert.equal(kinds.eventId, 'string');
    assert.equal(kinds.enabled, 'boolean');
    assert.equal(kinds.priority, 'integer');
    assert.equal(kinds.environment, 'enum');
    assert.equal(kinds.tags, 'array');
    assert.equal(kinds.owner, 'object');
  });

  it('marks required fields', () => {
    const required = (spec.children ?? []).filter((c) => c.required).map((c) => c.name);
    assert.deepEqual(required, ['eventId', 'title']);
  });

  it('treats anyOf with null as a nullable field', () => {
    const notes = (spec.children ?? []).find((c) => c.name === 'notes')!;
    assert.equal(notes.kind, 'string');
    assert.equal(notes.nullable, true);
  });

  it('describes array items', () => {
    const tags = (spec.children ?? []).find((c) => c.name === 'tags')!;
    assert.equal(tags.item?.kind, 'string');
  });

  it('recurses into nested objects', () => {
    const owner = (spec.children ?? []).find((c) => c.name === 'owner')!;
    assert.deepEqual(
      (owner.children ?? []).map((c) => c.name),
      ['name', 'email'],
    );
    assert.equal(owner.children?.[0].path, 'owner.name');
  });

  it('survives a schema with no type information', () => {
    const loose = normalizeSchema({});
    assert.equal(loose.kind, 'unknown');
  });

  it('stops recursing on a pathologically deep schema', () => {
    let deep: JsonSchema = { type: 'string' };
    for (let i = 0; i < 30; i++) {
      deep = { type: 'object', properties: { next: deep } };
    }
    const normalized = normalizeSchema(deep);
    let cursor = normalized;
    let depth = 0;
    while (cursor.children?.[0]) {
      cursor = cursor.children[0];
      depth++;
    }
    assert.ok(depth <= 8, `stopped at depth ${depth}`);
  });
});

describe('defaultsFor', () => {
  it('seeds declared defaults and required fields only', () => {
    const value = defaultsFor(normalizeSchema(EVENT_SCHEMA)) as Record<string, unknown>;
    assert.equal(value.enabled, true, 'declared default is used');
    assert.equal(value.eventId, '', 'required string is seeded empty');
    assert.ok(!('priority' in value), 'optional fields stay absent');
  });
});

describe('validateValue', () => {
  const spec = normalizeSchema(EVENT_SCHEMA);

  it('accepts a well-formed payload', () => {
    const errors = validateValue(spec, {
      eventId: 'evt-1',
      title: 'Launch',
      environment: 'QC',
      priority: 3,
      owner: { name: 'Sam' },
    });
    assert.deepEqual(errors, []);
  });

  it('reports missing required fields by path', () => {
    const errors = validateValue(spec, { title: 'Launch' });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].path, 'eventId');
  });

  it('rejects an empty string in a required field', () => {
    const errors = validateValue(spec, { eventId: '', title: 'Launch' });
    assert.ok(errors.some((e) => e.path === 'eventId'));
  });

  it('enforces enums, ranges and lengths', () => {
    const errors = validateValue(spec, {
      eventId: 'e',
      title: 'ab',
      environment: 'STAGING',
      priority: 9,
    });
    const paths = errors.map((e) => e.path);
    assert.ok(paths.includes('title'), 'minLength');
    assert.ok(paths.includes('environment'), 'enum');
    assert.ok(paths.includes('priority'), 'maximum');
  });

  it('checks string formats', () => {
    const errors = validateValue(spec, {
      eventId: 'e1',
      title: 'Launch',
      startsAt: '09/20/2026',
    });
    assert.ok(errors.some((e) => e.path === 'startsAt'));

    const ok = validateValue(spec, {
      eventId: 'e1',
      title: 'Launch',
      startsAt: '2026-09-20T00:00:00Z',
    });
    assert.deepEqual(ok, []);
  });

  it('validates inside arrays and nested objects', () => {
    const errors = validateValue(spec, {
      eventId: 'e1',
      title: 'Launch',
      tags: ['ok', 42],
      owner: { email: 'nope' },
    });
    const paths = errors.map((e) => e.path);
    assert.ok(paths.includes('tags[1]'));
    assert.ok(paths.includes('owner.name'));
    assert.ok(paths.includes('owner.email'));
  });

  it('accepts null for a nullable field', () => {
    const errors = validateValue(spec, { eventId: 'e1', title: 'Launch', notes: null });
    assert.deepEqual(errors, []);
  });
});

describe('pruneEmpty', () => {
  const spec = normalizeSchema(EVENT_SCHEMA);

  it('drops empty optional fields but keeps required ones', () => {
    const pruned = pruneEmpty(spec, {
      eventId: 'e1',
      title: 'Launch',
      environment: '',
      tags: [],
      owner: {},
    }) as Record<string, unknown>;

    assert.deepEqual(Object.keys(pruned).sort(), ['eventId', 'title']);
  });

  it('keeps false and zero, which are meaningful values', () => {
    const pruned = pruneEmpty(spec, {
      eventId: 'e1',
      title: 'Launch',
      enabled: false,
      priority: 0,
    }) as Record<string, unknown>;

    assert.equal(pruned.enabled, false);
    assert.equal(pruned.priority, 0);
  });

  it('preserves properties the schema never declared', () => {
    const pruned = pruneEmpty(spec, {
      eventId: 'e1',
      title: 'Launch',
      extra: 'kept',
    }) as Record<string, unknown>;
    assert.equal(pruned.extra, 'kept');
  });
});

describe('coerceInput', () => {
  const spec = normalizeSchema(EVENT_SCHEMA);
  const field = (name: string) => (spec.children ?? []).find((c) => c.name === name)!;

  it('turns form text into the declared type', () => {
    assert.equal(coerceInput(field('priority'), '4'), 4);
    assert.equal(coerceInput(field('enabled'), 'true'), true);
    assert.equal(coerceInput(field('environment'), 'QC'), 'QC');
    assert.equal(coerceInput(field('priority'), ''), null);
  });
});
