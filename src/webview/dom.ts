/** A minimal hyperscript helper. No framework: the payloads here are small and
 * the rendering is explicit, which keeps the webview bundle tiny. */

type Child = Node | string | number | null | undefined | false | Child[];

export interface Attrs {
  class?: string;
  id?: string;
  title?: string;
  type?: string;
  value?: string;
  placeholder?: string;
  href?: string;
  disabled?: boolean;
  checked?: boolean;
  rows?: number;
  spellcheck?: boolean;
  dataset?: Record<string, string>;
  style?: Partial<CSSStyleDeclaration>;
  onClick?: (event: MouseEvent) => void;
  onInput?: (event: Event) => void;
  onChange?: (event: Event) => void;
  onKeyDown?: (event: KeyboardEvent) => void;
  [key: string]: unknown;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) {
      continue;
    }
    if (key === 'class') {
      el.className = String(value);
    } else if (key === 'dataset') {
      Object.assign(el.dataset, value as Record<string, string>);
    } else if (key === 'style') {
      Object.assign(el.style, value as Partial<CSSStyleDeclaration>);
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(
        key.slice(2).toLowerCase(),
        value as EventListenerOrEventListenerObject,
      );
    } else if (key === 'checked' || key === 'disabled' || key === 'spellcheck') {
      (el as unknown as Record<string, unknown>)[key] = value;
    } else if (key === 'value') {
      (el as HTMLInputElement).value = String(value);
    } else {
      el.setAttribute(key, String(value));
    }
  }

  append(el, children);
  return el;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) {
      continue;
    }
    if (Array.isArray(child)) {
      append(parent, child);
    } else if (child instanceof Node) {
      parent.appendChild(child);
    } else {
      parent.appendChild(document.createTextNode(String(child)));
    }
  }
}

export function clear(node: Node): void {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

export function icon(name: string, extra?: string): HTMLElement {
  return h('span', { class: `codicon codicon-${name}${extra ? ' ' + extra : ''}` });
}

/** `codicon`-free status dot, so the webview needs no icon font. */
export function dot(state: string): HTMLElement {
  return h('span', { class: `dot dot-${state}` });
}

export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toTimeString().slice(0, 8);
}

export function formatDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

export function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Escapes nothing: text nodes are used everywhere, so HTML injection cannot occur. */
export function codeBlock(text: string, language = 'json'): HTMLElement {
  return h('pre', { class: `code code-${language}` }, h('code', null, text));
}
