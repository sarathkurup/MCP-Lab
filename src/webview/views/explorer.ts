import { normalizeSchema, validateValue } from '../../core/schema';
import type { Prompt, Resource, ResourceTemplate, Tool } from '../../core/protocol';
import type { ExecutionView, ServerDetail } from '../../shared/viewModels';
import type { AppContext, ViewDefinition } from '../app';
import { codeBlock, formatDuration, h, pretty } from '../dom';
import { renderResult } from '../resultViewer';
import { SchemaForm } from '../schemaForm';

interface ExplorerScratch {
  detail?: ServerDetail;
  filter: string;
  mode: 'form' | 'json';
  lastResult?: ExecutionView;
  busy: boolean;
  jsonDraft?: string;
  formValue?: unknown;
}

function scratch(ctx: AppContext): ExplorerScratch {
  const existing = ctx.state.scratch.explorer as ExplorerScratch | undefined;
  if (existing) {
    return existing;
  }
  const created: ExplorerScratch = { filter: '', mode: 'form', busy: false };
  ctx.state.scratch.explorer = created;
  return created;
}

export const explorerView: ViewDefinition = {
  id: 'explorer',
  label: 'Explorer',
  glyph: '⚒',

  async render(ctx) {
    const server = ctx.currentServer();
    const store = scratch(ctx);

    if (!server) {
      return emptyState('No server selected.', 'Add a server from the MCP Lab sidebar.');
    }

    if (server.status !== 'connected') {
      return emptyState(
        `${server.name} is ${server.status}.`,
        server.error ?? 'Connect the server to explore what it exposes.',
        h(
          'button',
          {
            class: 'btn-primary',
            onClick: async () => {
              await ctx.rpc.call('connect', { serverId: server.id });
              await ctx.reload();
            },
          },
          'Connect',
        ),
      );
    }

    // The detail payload is fetched per server and cached until the catalog moves.
    if (!store.detail || store.detail.id !== server.id) {
      store.detail = await ctx.rpc.call<ServerDetail>('serverDetail', { serverId: server.id });
      store.lastResult = undefined;
      store.formValue = undefined;
      store.jsonDraft = undefined;
    }

    const layout = h('div', { class: 'explorer' });
    layout.appendChild(renderCatalog(ctx, store));
    layout.appendChild(renderDetail(ctx, store));
    return layout;
  },
};

function renderCatalog(ctx: AppContext, store: ExplorerScratch): HTMLElement {
  const detail = store.detail!;
  const filter = store.filter.toLowerCase();

  const matches = (name: string, description?: string) =>
    !filter ||
    name.toLowerCase().includes(filter) ||
    (description ?? '').toLowerCase().includes(filter);

  const search = h('input', {
    class: 'control-input',
    type: 'search',
    placeholder: 'Filter tools, resources, prompts…',
    value: store.filter,
    onInput: (event) => {
      store.filter = (event.target as HTMLInputElement).value;
      ctx.refresh();
    },
  });

  const panel = h('aside', { class: 'catalog' }, h('div', { class: 'catalog-search' }, search));

  const tools = detail.tools.filter((t) => matches(t.name, t.description));
  const resources = [...detail.resources, ...detail.resourceTemplates].filter((r) =>
    matches(r.name, r.description),
  );
  const prompts = detail.prompts.filter((p) => matches(p.name, p.description));

  panel.appendChild(
    section('Tools', tools.length, detail.tools.length, tools.map((tool) =>
      catalogRow(
        ctx,
        store,
        'tool',
        tool.name,
        tool.description,
        tool.annotations?.destructiveHint
          ? 'destructive'
          : tool.annotations?.readOnlyHint
            ? 'read'
            : 'write',
      ),
    )),
  );

  panel.appendChild(
    section('Resources', resources.length, detail.resources.length + detail.resourceTemplates.length,
      resources.map((resource) =>
        catalogRow(
          ctx,
          store,
          'resource',
          'uri' in resource ? resource.uri : resource.uriTemplate,
          resource.description,
          'uriTemplate' in resource ? 'template' : undefined,
          resource.name,
        ),
      ),
    ),
  );

  panel.appendChild(
    section('Prompts', prompts.length, detail.prompts.length, prompts.map((prompt) =>
      catalogRow(ctx, store, 'prompt', prompt.name, prompt.description),
    )),
  );

  return panel;
}

function section(
  title: string,
  shown: number,
  total: number,
  rows: HTMLElement[],
): HTMLElement {
  return h(
    'div',
    { class: 'catalog-section' },
    h(
      'h3',
      null,
      title,
      h('span', { class: 'count' }, shown === total ? String(total) : `${shown}/${total}`),
    ),
    rows.length
      ? h('div', { class: 'catalog-rows' }, ...rows)
      : h('p', { class: 'muted small' }, 'None'),
  );
}

function catalogRow(
  ctx: AppContext,
  store: ExplorerScratch,
  kind: 'tool' | 'resource' | 'prompt',
  name: string,
  description?: string,
  badge?: string,
  displayName?: string,
): HTMLElement {
  const selected = ctx.state.selection?.kind === kind && ctx.state.selection.name === name;
  return h(
    'button',
    {
      class: `catalog-row${selected ? ' selected' : ''}`,
      onClick: () => {
        ctx.state.selection = { kind, name };
        store.lastResult = undefined;
        store.formValue = undefined;
        store.jsonDraft = undefined;
        ctx.refresh();
      },
    },
    h(
      'div',
      { class: 'catalog-row-head' },
      h('span', { class: 'catalog-name' }, displayName ?? name),
      badge ? h('span', { class: `badge badge-${badge}` }, badge) : null,
    ),
    description
      ? h('span', { class: 'catalog-desc' }, firstLine(description))
      : displayName
        ? h('span', { class: 'catalog-desc' }, name)
        : null,
  );
}

function renderDetail(ctx: AppContext, store: ExplorerScratch): HTMLElement {
  const detail = store.detail!;
  const selection = ctx.state.selection;
  const main = h('section', { class: 'detail' });

  if (!selection) {
    main.appendChild(serverOverview(detail));
    return main;
  }

  if (selection.kind === 'tool') {
    const tool = detail.tools.find((t) => t.name === selection.name);
    if (!tool) {
      main.appendChild(emptyState('Tool not found', 'It may have been removed by the server.'));
      return main;
    }
    main.appendChild(renderToolDetail(ctx, store, tool));
    return main;
  }

  if (selection.kind === 'resource') {
    const resource =
      detail.resources.find((r) => r.uri === selection.name) ??
      detail.resourceTemplates.find((r) => r.uriTemplate === selection.name);
    main.appendChild(renderResourceDetail(ctx, store, resource, selection.name));
    return main;
  }

  const prompt = detail.prompts.find((p) => p.name === selection.name);
  if (!prompt) {
    main.appendChild(emptyState('Prompt not found', ''));
    return main;
  }
  main.appendChild(renderPromptDetail(ctx, store, prompt));
  return main;
}

function serverOverview(detail: ServerDetail): HTMLElement {
  return h(
    'div',
    { class: 'overview' },
    h('h2', null, detail.name),
    h(
      'dl',
      { class: 'meta-grid' },
      meta('Implementation', detail.serverInfo ? `${detail.serverInfo.name} v${detail.serverInfo.version}` : '—'),
      meta('Protocol', detail.protocolVersion ?? '—'),
      meta('Transport', detail.transport),
      meta('Target', detail.target),
      meta('Tools', String(detail.counts.tools)),
      meta('Resources', String(detail.counts.resources)),
      meta('Prompts', String(detail.counts.prompts)),
    ),
    detail.instructions
      ? h('div', { class: 'panel' }, h('h3', null, 'Server instructions'), h('p', null, detail.instructions))
      : null,
    h('h3', null, 'Capabilities'),
    codeBlock(pretty(detail.capabilities ?? {})),
  );
}

function meta(label: string, value: string): HTMLElement {
  return h('div', { class: 'meta' }, h('dt', null, label), h('dd', null, value));
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function renderToolDetail(ctx: AppContext, store: ExplorerScratch, tool: Tool): HTMLElement {
  const spec = normalizeSchema(tool.inputSchema);
  const container = h('div', { class: 'tool-detail' });

  const annotations = tool.annotations ?? {};
  container.appendChild(
    h(
      'header',
      { class: 'detail-head' },
      h('h2', null, tool.name),
      annotations.destructiveHint ? h('span', { class: 'badge badge-destructive' }, 'destructive') : null,
      annotations.readOnlyHint ? h('span', { class: 'badge badge-read' }, 'read-only') : null,
      annotations.idempotentHint ? h('span', { class: 'badge' }, 'idempotent') : null,
    ),
  );

  if (tool.description) {
    container.appendChild(h('p', { class: 'detail-description' }, tool.description));
  }

  // A failed request handed back by "Fix request" wins over the cached value.
  const pendingFix = ctx.state.scratch.pendingFix;
  if (pendingFix !== undefined) {
    store.formValue = pendingFix;
    store.jsonDraft = undefined;
    delete (ctx.state.scratch as Record<string, unknown>).pendingFix;
  }

  const form = new SchemaForm(spec, store.formValue, () => {
    store.formValue = form.getValue();
  });
  if (store.formValue === undefined) {
    store.formValue = form.getValue();
  }

  const jsonArea = h('textarea', {
    class: 'control-input mono json-editor',
    rows: 12,
    spellcheck: false,
    value: store.jsonDraft ?? pretty(store.formValue ?? {}),
    onInput: (event) => {
      store.jsonDraft = (event.target as HTMLTextAreaElement).value;
    },
  });

  const formPane = h('div', { class: 'pane' }, form.element);
  const jsonPane = h('div', { class: 'pane hidden' }, jsonArea);

  const setMode = (mode: 'form' | 'json') => {
    // Switching carries the current value across so nothing is silently lost.
    if (mode === 'json') {
      store.jsonDraft = pretty(form.getValue());
      jsonArea.value = store.jsonDraft;
    } else if (store.jsonDraft !== undefined) {
      try {
        form.setValue(JSON.parse(store.jsonDraft));
        store.formValue = form.getValue();
      } catch {
        ctx.toast('JSON is not valid; the form still shows the last good value.', 'error');
      }
    }
    store.mode = mode;
    formPane.classList.toggle('hidden', mode !== 'form');
    jsonPane.classList.toggle('hidden', mode !== 'json');
    formTab.classList.toggle('active', mode === 'form');
    jsonTab.classList.toggle('active', mode === 'json');
  };

  const formTab = h(
    'button',
    { class: `tab${store.mode === 'form' ? ' active' : ''}`, onClick: () => setMode('form') },
    'Form',
  );
  const jsonTab = h(
    'button',
    { class: `tab${store.mode === 'json' ? ' active' : ''}`, onClick: () => setMode('json') },
    'JSON',
  );

  const resultHost = h('div', { class: 'result-host' });
  if (store.lastResult) {
    resultHost.appendChild(renderResult(ctx, store.lastResult));
  }

  const execute = h(
    'button',
    {
      class: 'btn-primary',
      onClick: async () => {
        if (store.busy) {
          return;
        }
        let args: unknown;
        if (store.mode === 'json') {
          try {
            args = JSON.parse(jsonArea.value || '{}');
          } catch (err) {
            ctx.toast(`Invalid JSON: ${(err as Error).message}`, 'error');
            return;
          }
        } else {
          args = form.getValue();
        }

        // Client-side validation first, so a bad request never leaves Workbench
        // unless the user explicitly chose raw JSON mode.
        if (store.mode === 'form') {
          const errors = validateValue(spec, args);
          if (errors.length > 0) {
            form.showErrors(errors.map((e) => e.path));
            ctx.toast(errors.map((e) => `${e.path}: ${e.message}`).join('\n'), 'error');
            return;
          }
          form.showErrors([]);
        }

        store.busy = true;
        execute.textContent = 'Running…';
        execute.disabled = true;
        try {
          const view = await ctx.rpc.call<ExecutionView>('executeTool', {
            serverId: ctx.state.serverId,
            name: tool.name,
            args,
            skipValidation: store.mode === 'json',
          });
          store.lastResult = view;
          resultHost.replaceChildren(renderResult(ctx, view));
        } catch (err) {
          ctx.toast((err as Error).message, 'error');
        } finally {
          store.busy = false;
          execute.textContent = 'Execute';
          execute.disabled = false;
        }
      },
    },
    'Execute',
  );

  container.appendChild(
    h(
      'div',
      { class: 'section' },
      h(
        'div',
        { class: 'section-head' },
        h('h3', null, 'Input'),
        h('div', { class: 'tabs' }, formTab, jsonTab),
      ),
      formPane,
      jsonPane,
      h('div', { class: 'actions' }, execute),
    ),
  );

  container.appendChild(resultHost);

  container.appendChild(
    collapsible('Input schema', codeBlock(pretty(tool.inputSchema))),
  );
  if (tool.outputSchema) {
    container.appendChild(collapsible('Output schema', codeBlock(pretty(tool.outputSchema))));
  }

  return container;
}

// ---------------------------------------------------------------------------
// Resources & prompts
// ---------------------------------------------------------------------------

function renderResourceDetail(
  ctx: AppContext,
  store: ExplorerScratch,
  resource: Resource | ResourceTemplate | undefined,
  uri: string,
): HTMLElement {
  const isTemplate = !!resource && 'uriTemplate' in resource;
  const container = h('div', { class: 'tool-detail' });

  container.appendChild(
    h(
      'header',
      { class: 'detail-head' },
      h('h2', null, resource?.name ?? uri),
      isTemplate ? h('span', { class: 'badge badge-template' }, 'template') : null,
    ),
  );
  container.appendChild(h('p', { class: 'detail-uri mono' }, uri));
  if (resource?.description) {
    container.appendChild(h('p', { class: 'detail-description' }, resource.description));
  }

  const uriInput = h('input', {
    class: 'control-input mono',
    value: uri,
    spellcheck: false,
  });

  const resultHost = h('div', { class: 'result-host' });
  if (store.lastResult) {
    resultHost.appendChild(renderResult(ctx, store.lastResult));
  }

  const read = h(
    'button',
    {
      class: 'btn-primary',
      onClick: async () => {
        read.disabled = true;
        read.textContent = 'Reading…';
        try {
          const view = await ctx.rpc.call<ExecutionView>('readResource', {
            serverId: ctx.state.serverId,
            uri: uriInput.value,
          });
          store.lastResult = view;
          resultHost.replaceChildren(renderResult(ctx, view));
        } catch (err) {
          ctx.toast((err as Error).message, 'error');
        } finally {
          read.disabled = false;
          read.textContent = 'Read resource';
        }
      },
    },
    'Read resource',
  );

  container.appendChild(
    h(
      'div',
      { class: 'section' },
      h('h3', null, isTemplate ? 'URI (fill in the template)' : 'URI'),
      uriInput,
      h('div', { class: 'actions' }, read),
    ),
  );
  container.appendChild(resultHost);
  return container;
}

function renderPromptDetail(
  ctx: AppContext,
  store: ExplorerScratch,
  prompt: Prompt,
): HTMLElement {
  const container = h('div', { class: 'tool-detail' });
  container.appendChild(h('header', { class: 'detail-head' }, h('h2', null, prompt.name)));
  if (prompt.description) {
    container.appendChild(h('p', { class: 'detail-description' }, prompt.description));
  }

  const inputs = new Map<string, HTMLInputElement>();
  const fields = h('div', { class: 'schema-form' });
  for (const arg of prompt.arguments ?? []) {
    const input = h('input', { class: 'control-input', spellcheck: false });
    inputs.set(arg.name, input);
    fields.appendChild(
      h(
        'div',
        { class: 'field field-string' },
        h(
          'label',
          { class: 'field-label' },
          h('span', { class: 'field-name' }, arg.name),
          arg.required ? h('span', { class: 'required' }, '*') : null,
          h('span', { class: 'field-type' }, 'string'),
        ),
        arg.description ? h('p', { class: 'field-description' }, arg.description) : null,
        h('div', { class: 'control' }, input),
      ),
    );
  }
  if ((prompt.arguments ?? []).length === 0) {
    fields.appendChild(h('p', { class: 'muted' }, 'This prompt takes no arguments.'));
  }

  const resultHost = h('div', { class: 'result-host' });
  if (store.lastResult) {
    resultHost.appendChild(renderResult(ctx, store.lastResult));
  }

  const run = h(
    'button',
    {
      class: 'btn-primary',
      onClick: async () => {
        const args: Record<string, string> = {};
        for (const [name, input] of inputs) {
          if (input.value !== '') {
            args[name] = input.value;
          }
        }
        const missing = (prompt.arguments ?? [])
          .filter((a) => a.required && !args[a.name])
          .map((a) => a.name);
        if (missing.length) {
          ctx.toast(`Missing required argument(s): ${missing.join(', ')}`, 'error');
          return;
        }

        run.disabled = true;
        try {
          const view = await ctx.rpc.call<ExecutionView>('getPrompt', {
            serverId: ctx.state.serverId,
            name: prompt.name,
            args,
          });
          store.lastResult = view;
          resultHost.replaceChildren(renderResult(ctx, view));
        } catch (err) {
          ctx.toast((err as Error).message, 'error');
        } finally {
          run.disabled = false;
        }
      },
    },
    'Run prompt',
  );

  container.appendChild(
    h('div', { class: 'section' }, h('h3', null, 'Arguments'), fields, h('div', { class: 'actions' }, run)),
  );
  container.appendChild(resultHost);
  return container;
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

export function emptyState(title: string, detail: string, action?: HTMLElement): HTMLElement {
  return h(
    'div',
    { class: 'empty-state' },
    h('h2', null, title),
    detail ? h('p', null, detail) : null,
    action ?? null,
  );
}

export function collapsible(title: string, content: HTMLElement, open = false): HTMLElement {
  const details = h('details', { class: 'collapsible' }, h('summary', null, title), content);
  details.open = open;
  return details;
}

export function durationLabel(ms: number): string {
  return formatDuration(ms);
}

function firstLine(value: string): string {
  const line = value.split('\n')[0].trim();
  return line.length > 90 ? `${line.slice(0, 87)}…` : line;
}
