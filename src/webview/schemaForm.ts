import { defaultsFor, type FieldSpec } from '../core/schema';
import { h } from './dom';

/**
 * Renders a form straight from a normalized JSON schema. Nothing here knows
 * about any particular tool - every control is derived from the spec, which is
 * what makes the explorer work against a server it has never seen.
 */
export class SchemaForm {
  readonly element: HTMLElement;
  private value: Record<string, unknown>;

  constructor(
    private readonly spec: FieldSpec,
    initial?: unknown,
    private readonly onChange?: () => void,
  ) {
    const seed = initial !== undefined ? initial : defaultsFor(spec);
    this.value =
      seed && typeof seed === 'object' && !Array.isArray(seed)
        ? ({ ...(seed as Record<string, unknown>) } as Record<string, unknown>)
        : {};
    this.element = h('div', { class: 'schema-form' });
    this.render();
  }

  getValue(): unknown {
    return this.value;
  }

  setValue(next: unknown): void {
    this.value =
      next && typeof next === 'object' && !Array.isArray(next)
        ? ({ ...(next as Record<string, unknown>) } as Record<string, unknown>)
        : {};
    this.render();
  }

  private render(): void {
    this.element.replaceChildren();

    const children = this.spec.children ?? [];
    if (children.length === 0) {
      this.element.appendChild(
        h(
          'p',
          { class: 'muted' },
          this.spec.kind === 'object'
            ? 'This tool takes no parameters.'
            : 'This schema has no named properties; use JSON mode.',
        ),
      );
      return;
    }

    for (const child of children) {
      this.element.appendChild(this.renderField(child, this.value, child.name));
    }
  }

  private notify(): void {
    this.onChange?.();
  }

  private renderField(
    spec: FieldSpec,
    container: Record<string, unknown> | unknown[],
    key: string | number,
  ): HTMLElement {
    const read = () => (container as Record<string | number, unknown>)[key];
    const write = (next: unknown) => {
      (container as Record<string | number, unknown>)[key] = next;
      this.notify();
    };

    const control = this.renderControl(spec, read, write);

    const label = h(
      'label',
      { class: 'field-label' },
      h('span', { class: 'field-name' }, spec.name || spec.label),
      spec.required ? h('span', { class: 'required' }, '*') : null,
      h('span', { class: 'field-type' }, typeLabel(spec)),
    );

    const field = h(
      'div',
      { class: `field field-${spec.kind}` },
      label,
      spec.description ? h('p', { class: 'field-description' }, spec.description) : null,
      control,
    );
    field.dataset.path = spec.path;
    return field;
  }

  private renderControl(
    spec: FieldSpec,
    read: () => unknown,
    write: (next: unknown) => void,
  ): HTMLElement {
    switch (spec.kind) {
      case 'boolean':
        return this.renderBoolean(read, write);
      case 'enum':
        return this.renderEnum(spec, read, write);
      case 'number':
      case 'integer':
        return this.renderNumber(spec, read, write);
      case 'string':
        return this.renderString(spec, read, write);
      case 'array':
        return this.renderArray(spec, read, write);
      case 'object':
        return this.renderObject(spec, read, write);
      default:
        return this.renderRawJson(read, write);
    }
  }

  private renderBoolean(read: () => unknown, write: (next: unknown) => void): HTMLElement {
    const input = h('input', {
      type: 'checkbox',
      checked: read() === true,
      onChange: (event) => write((event.target as HTMLInputElement).checked),
    });
    return h('div', { class: 'control control-boolean' }, input);
  }

  private renderEnum(
    spec: FieldSpec,
    read: () => unknown,
    write: (next: unknown) => void,
  ): HTMLElement {
    const options = spec.enumValues ?? (spec.schema.const !== undefined ? [spec.schema.const] : []);
    const select = h('select', {
      class: 'control-input',
      onChange: (event) => {
        const raw = (event.target as HTMLSelectElement).value;
        if (raw === '__unset__') {
          write(undefined);
          return;
        }
        write(options[Number(raw)]);
      },
    });

    if (!spec.required) {
      select.appendChild(h('option', { value: '__unset__' }, '(not set)'));
    }
    options.forEach((option, index) => {
      const opt = h('option', { value: String(index) }, String(option));
      if (JSON.stringify(option) === JSON.stringify(read())) {
        opt.selected = true;
      }
      select.appendChild(opt);
    });

    return h('div', { class: 'control' }, select);
  }

  private renderNumber(
    spec: FieldSpec,
    read: () => unknown,
    write: (next: unknown) => void,
  ): HTMLElement {
    const current = read();
    const input = h('input', {
      class: 'control-input',
      type: 'number',
      value: current === null || current === undefined ? '' : String(current),
      placeholder: spec.constraints.minimum !== undefined ? `min ${spec.constraints.minimum}` : '',
      onInput: (event) => {
        const raw = (event.target as HTMLInputElement).value;
        if (raw === '') {
          write(spec.required ? null : undefined);
          return;
        }
        const parsed = Number(raw);
        write(Number.isNaN(parsed) ? raw : parsed);
      },
    });
    if (spec.constraints.minimum !== undefined) {
      input.min = String(spec.constraints.minimum);
    }
    if (spec.constraints.maximum !== undefined) {
      input.max = String(spec.constraints.maximum);
    }
    if (spec.kind === 'integer') {
      input.step = '1';
    }
    return h('div', { class: 'control' }, input);
  }

  private renderString(
    spec: FieldSpec,
    read: () => unknown,
    write: (next: unknown) => void,
  ): HTMLElement {
    const current = read();
    const multiline =
      spec.format === 'textarea' ||
      (spec.constraints.maxLength ?? 0) > 200 ||
      /body|content|text|markdown|description|query/i.test(spec.name);

    const onInput = (event: Event) => {
      const raw = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
      write(raw === '' && !spec.required ? undefined : raw);
    };

    const control = multiline
      ? h('textarea', {
          class: 'control-input',
          rows: 4,
          spellcheck: false,
          value: current == null ? '' : String(current),
          onInput,
        })
      : h('input', {
          class: 'control-input',
          type: inputTypeFor(spec.format),
          value: current == null ? '' : String(current),
          placeholder: placeholderFor(spec),
          spellcheck: false,
          onInput,
        });

    return h('div', { class: 'control' }, control);
  }

  private renderArray(
    spec: FieldSpec,
    read: () => unknown,
    write: (next: unknown) => void,
  ): HTMLElement {
    const current = Array.isArray(read()) ? (read() as unknown[]) : [];
    const list = h('div', { class: 'array-items' });

    current.forEach((_, index) => {
      const itemSpec: FieldSpec = { ...spec.item!, path: `${spec.path}[${index}]`, name: `${index}` };
      const row = h(
        'div',
        { class: 'array-item' },
        h('span', { class: 'array-index' }, `${index}`),
        this.renderControl(
          itemSpec,
          () => current[index],
          (next) => {
            current[index] = next;
            write(current);
          },
        ),
        h(
          'button',
          {
            class: 'btn-ghost',
            title: 'Remove item',
            onClick: () => {
              current.splice(index, 1);
              write(current);
              this.rerenderField(spec.path);
            },
          },
          '✕',
        ),
      );
      list.appendChild(row);
    });

    const add = h(
      'button',
      {
        class: 'btn-secondary',
        onClick: () => {
          current.push(defaultsFor(spec.item!));
          write(current);
          this.rerenderField(spec.path);
        },
      },
      '+ Add item',
    );

    return h('div', { class: 'control control-array' }, list, add);
  }

  private renderObject(
    spec: FieldSpec,
    read: () => unknown,
    write: (next: unknown) => void,
  ): HTMLElement {
    let current = read();
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      current = {};
      write(current);
    }
    const record = current as Record<string, unknown>;

    const box = h('div', { class: 'control control-object' });
    for (const child of spec.children ?? []) {
      box.appendChild(this.renderField(child, record, child.name));
    }
    if ((spec.children ?? []).length === 0) {
      box.appendChild(this.renderRawJson(read, write));
    }
    return box;
  }

  private renderRawJson(read: () => unknown, write: (next: unknown) => void): HTMLElement {
    const area = h('textarea', {
      class: 'control-input mono',
      rows: 3,
      spellcheck: false,
      value: read() === undefined ? '' : JSON.stringify(read(), null, 2),
      onInput: (event) => {
        const raw = (event.target as HTMLTextAreaElement).value;
        if (raw.trim() === '') {
          write(undefined);
          area.classList.remove('invalid');
          return;
        }
        try {
          write(JSON.parse(raw));
          area.classList.remove('invalid');
        } catch {
          // Keep the text so the user can fix it; the value simply is not updated.
          area.classList.add('invalid');
        }
      },
    });
    return h('div', { class: 'control' }, area);
  }

  /** Arrays change shape, so their subtree is rebuilt in place. */
  private rerenderField(path: string): void {
    const existing = this.element.querySelector<HTMLElement>(`[data-path="${cssEscape(path)}"]`);
    if (!existing) {
      this.render();
      return;
    }
    const spec = findSpec(this.spec, path);
    if (!spec) {
      this.render();
      return;
    }
    const { container, key } = resolveContainer(this.value, path);
    if (!container) {
      this.render();
      return;
    }
    const replacement = this.renderField(spec, container, key);
    existing.replaceWith(replacement);
  }

  /** Marks fields that failed validation, by schema path. */
  showErrors(paths: string[]): void {
    for (const el of this.element.querySelectorAll('.field')) {
      el.classList.remove('field-error');
    }
    for (const path of paths) {
      const el = this.element.querySelector(`[data-path="${cssEscape(path)}"]`);
      el?.classList.add('field-error');
    }
  }
}

function findSpec(root: FieldSpec, path: string): FieldSpec | undefined {
  if (root.path === path) {
    return root;
  }
  for (const child of root.children ?? []) {
    const found = findSpec(child, path);
    if (found) {
      return found;
    }
  }
  if (root.item) {
    const found = findSpec(root.item, path);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function resolveContainer(
  root: Record<string, unknown>,
  path: string,
): { container?: Record<string, unknown> | unknown[]; key: string | number } {
  const segments = path.split('.');
  const key = segments.pop() ?? '';
  let cursor: unknown = root;
  for (const segment of segments) {
    if (cursor && typeof cursor === 'object') {
      cursor = (cursor as Record<string, unknown>)[segment];
    } else {
      return { container: undefined, key };
    }
  }
  return {
    container: cursor as Record<string, unknown> | undefined,
    key,
  };
}

function typeLabel(spec: FieldSpec): string {
  if (spec.kind === 'enum') {
    return 'enum';
  }
  if (spec.kind === 'array' && spec.item) {
    return `${spec.item.kind}[]`;
  }
  return spec.nullable ? `${spec.kind}?` : spec.kind;
}

function inputTypeFor(format?: string): string {
  switch (format) {
    case 'date':
      return 'date';
    case 'date-time':
      return 'datetime-local';
    case 'time':
      return 'time';
    case 'email':
      return 'email';
    case 'uri':
    case 'url':
      return 'url';
    case 'password':
      return 'password';
    default:
      return 'text';
  }
}

function placeholderFor(spec: FieldSpec): string {
  if (spec.format) {
    return spec.format;
  }
  if (spec.constraints.pattern) {
    return spec.constraints.pattern;
  }
  return '';
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
