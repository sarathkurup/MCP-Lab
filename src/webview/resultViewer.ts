import type { CallToolResult, ContentBlock, GetPromptResult, ReadResourceResult } from '../core/protocol';
import type { ExecutionView } from '../shared/viewModels';
import type { AppContext } from './app';
import { codeBlock, formatDuration, h, pretty } from './dom';

/**
 * Renders whatever a server sent back: content blocks, structured output,
 * embedded resources, images, or an error - plus the request that produced it.
 */
export function renderResult(ctx: AppContext, view: ExecutionView): HTMLElement {
  const { entry } = view;
  const failed = !!entry.error;
  const toolError = !!entry.toolError;

  const status = failed
    ? h('span', { class: 'badge badge-destructive' }, 'error')
    : toolError
      ? h('span', { class: 'badge badge-warn' }, 'tool error')
      : h('span', { class: 'badge badge-ok' }, 'ok');

  const head = h(
    'div',
    { class: 'result-head' },
    h('h3', null, 'Response'),
    status,
    h('span', { class: 'muted' }, formatDuration(entry.durationMs)),
    h('span', { class: 'spacer' }),
    iconButton('Copy', () => {
      void navigator.clipboard.writeText(pretty(entry.error ?? entry.output));
      ctx.toast('Response copied.');
    }),
    iconButton('Save…', () => {
      void ctx.rpc.call('saveResponse', { historyId: entry.id });
    }),
    iconButton('Replay', async () => {
      try {
        const replayed = await ctx.rpc.call<ExecutionView>('replay', { historyId: entry.id });
        const host = document.querySelector('.result-host');
        host?.replaceChildren(renderResult(ctx, replayed));
      } catch (err) {
        ctx.toast((err as Error).message, 'error');
      }
    }),
  );

  const body = h('div', { class: 'result-body' });

  if (entry.error) {
    body.appendChild(
      h(
        'div',
        { class: 'error-box' },
        h('div', { class: 'error-title' }, entry.error.message),
        entry.error.code !== undefined
          ? h('div', { class: 'muted small' }, `JSON-RPC code ${entry.error.code}`)
          : null,
        entry.error.data !== undefined ? codeBlock(pretty(entry.error.data)) : null,
      ),
    );
    body.appendChild(
      h(
        'div',
        { class: 'actions' },
        h(
          'button',
          {
            class: 'btn-secondary',
            onClick: () => void ctx.rpc.call('analyzeFailure', { historyId: entry.id }),
          },
          '🤖 Analyze with AI',
        ),
      ),
    );
  } else {
    body.appendChild(renderOutput(entry.kind, entry.output));
  }

  const request = h(
    'details',
    { class: 'collapsible' },
    h('summary', null, 'Request'),
    codeBlock(pretty(entry.input)),
  );

  return h('div', { class: `result${failed ? ' result-failed' : ''}` }, head, body, request);
}

function renderOutput(kind: string, output: unknown): HTMLElement {
  if (output === undefined) {
    return h('p', { class: 'muted' }, 'No output.');
  }

  if (kind === 'tool') {
    const result = output as CallToolResult;
    const wrap = h('div', { class: 'content-blocks' });
    for (const block of result.content ?? []) {
      wrap.appendChild(renderBlock(block));
    }
    if (result.structuredContent !== undefined) {
      wrap.appendChild(
        h(
          'div',
          { class: 'panel' },
          h('h4', null, 'Structured content'),
          codeBlock(pretty(result.structuredContent)),
        ),
      );
    }
    if ((result.content ?? []).length === 0 && result.structuredContent === undefined) {
      wrap.appendChild(codeBlock(pretty(result)));
    }
    return wrap;
  }

  if (kind === 'resource') {
    const result = output as ReadResourceResult;
    const wrap = h('div', { class: 'content-blocks' });
    for (const contents of result.contents ?? []) {
      if ('text' in contents) {
        wrap.appendChild(renderText(contents.text, contents.mimeType));
      } else {
        wrap.appendChild(renderBinary(contents.blob, contents.mimeType));
      }
    }
    return wrap;
  }

  if (kind === 'prompt') {
    const result = output as GetPromptResult;
    const wrap = h('div', { class: 'content-blocks' });
    if (result.description) {
      wrap.appendChild(h('p', { class: 'muted' }, result.description));
    }
    for (const message of result.messages ?? []) {
      wrap.appendChild(
        h(
          'div',
          { class: `message message-${message.role}` },
          h('div', { class: 'message-role' }, message.role),
          renderBlock(message.content),
        ),
      );
    }
    return wrap;
  }

  return codeBlock(pretty(output));
}

function renderBlock(block: ContentBlock): HTMLElement {
  switch (block.type) {
    case 'text':
      return renderText((block as { text: string }).text);
    case 'image':
    case 'audio': {
      const typed = block as { data: string; mimeType: string };
      return renderBinary(typed.data, typed.mimeType);
    }
    case 'resource_link': {
      const typed = block as { uri: string; name?: string };
      return h(
        'div',
        { class: 'panel' },
        h('h4', null, 'Resource link'),
        h('code', null, typed.uri),
        typed.name ? h('span', { class: 'muted' }, ` — ${typed.name}`) : null,
      );
    }
    case 'resource': {
      const typed = block as { resource: { text?: string; blob?: string; mimeType?: string; uri: string } };
      return h(
        'div',
        { class: 'panel' },
        h('h4', null, `Embedded resource: ${typed.resource.uri}`),
        typed.resource.text !== undefined
          ? renderText(typed.resource.text, typed.resource.mimeType)
          : renderBinary(typed.resource.blob ?? '', typed.resource.mimeType),
      );
    }
    default:
      return codeBlock(pretty(block));
  }
}

function renderText(text: string, mimeType?: string): HTMLElement {
  const trimmed = text.trim();
  const looksJson =
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'));

  if (looksJson || mimeType?.includes('json')) {
    try {
      return codeBlock(pretty(JSON.parse(trimmed)));
    } catch {
      // Fall through: not actually JSON.
    }
  }

  if (mimeType?.includes('markdown')) {
    return h('div', { class: 'markdown' }, renderMarkdown(text));
  }

  return h('pre', { class: 'text-block' }, text);
}

function renderBinary(data: string, mimeType?: string): HTMLElement {
  if (mimeType?.startsWith('image/')) {
    const img = h('img', { class: 'result-image' });
    (img as HTMLImageElement).src = `data:${mimeType};base64,${data}`;
    return h('div', { class: 'panel' }, img);
  }
  if (mimeType?.startsWith('audio/')) {
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.src = `data:${mimeType};base64,${data}`;
    return h('div', { class: 'panel' }, audio);
  }
  return h(
    'div',
    { class: 'panel' },
    h('h4', null, mimeType ?? 'binary'),
    h('p', { class: 'muted small' }, `${data.length} base64 characters`),
  );
}

/** Deliberately tiny: headings, bold, code and lists. No HTML is ever injected. */
function renderMarkdown(source: string): HTMLElement[] {
  return source.split('\n').map((line) => {
    if (line.startsWith('### ')) {
      return h('h4', null, line.slice(4));
    }
    if (line.startsWith('## ')) {
      return h('h3', null, line.slice(3));
    }
    if (line.startsWith('# ')) {
      return h('h2', null, line.slice(2));
    }
    if (/^\s*[-*]\s+/.test(line)) {
      return h('div', { class: 'md-li' }, `• ${line.replace(/^\s*[-*]\s+/, '')}`);
    }
    return h('p', null, line);
  });
}

function iconButton(label: string, onClick: () => void): HTMLElement {
  return h('button', { class: 'btn-ghost', onClick }, label);
}
