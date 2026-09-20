import { diffCatalogKeys } from '../../core/catalog';
import { classifyTool } from '../../core/environments';
import type { Prompt, Resource, ResourceTemplate, Tool } from '../../core/protocol';
import type { ServerDetail } from '../../shared/viewModels';
import type { AppContext, ViewDefinition } from '../app';
import { h, svg } from '../dom';
import { emptyState } from './explorer';

/**
 * A capability map: one server drawn as a tree of what it exposes.
 *
 * The explorer answers "what can I call and what does it take". This answers
 * the shape question instead - how much of this server is read versus
 * destructive, whether it has resources at all, and what moved since the last
 * time you looked. That last part is the reason it redraws itself: MCP servers
 * announce `notifications/tools/list_changed`, the engine refetches the catalog,
 * and anything that appeared is ringed until you have seen it.
 *
 * Drawn as plain SVG rather than with a graph library, because the extension
 * ships with no runtime dependencies and a tree this shallow does not need one.
 */

const ROW_H = 26;
const COL_SERVER = 8;
const COL_GROUP = 172;
const COL_LEAF = 330;
const NODE_H = 20;
const LEAF_W = 232;
const GROUP_W = 128;
const SERVER_W = 150;
const PAD_Y = 16;
/** Beyond this a column stops being a diagram and starts being a list. */
const MAX_LEAVES = 14;

interface MapScratch {
  detailId?: string;
  detail?: ServerDetail;
  /** Item keys seen on a previous render, per server, to spot additions. */
  seen: Record<string, string[]>;
  /** Keys added by the most recent catalog change. */
  fresh: string[];
  groups: Record<string, boolean>;
}

function scratch(ctx: AppContext): MapScratch {
  const existing = ctx.state.scratch.map as MapScratch | undefined;
  if (existing) return existing;
  const created: MapScratch = { seen: {}, fresh: [], groups: {} };
  ctx.state.scratch.map = created;
  return created;
}

interface Leaf {
  key: string;
  label: string;
  kind: 'tool' | 'resource' | 'prompt';
  tone: string;
  detail?: string;
  /** Explorer selection to jump to, when the item is addressable by name. */
  select?: { kind: 'tool' | 'resource' | 'prompt'; name: string };
}

interface Group {
  id: string;
  label: string;
  leaves: Leaf[];
  tone: string;
}

function toolLeaf(tool: Tool): Leaf {
  const risk = classifyTool(tool);
  return {
    key: `tool:${tool.name}`,
    label: tool.name,
    kind: 'tool',
    tone: risk,
    detail: tool.description,
    select: { kind: 'tool', name: tool.name },
  };
}

function resourceLeaf(resource: Resource): Leaf {
  return {
    key: `resource:${resource.uri}`,
    label: resource.name || resource.uri,
    kind: 'resource',
    tone: 'resource',
    detail: resource.uri,
    select: { kind: 'resource', name: resource.uri },
  };
}

function templateLeaf(template: ResourceTemplate): Leaf {
  return {
    key: `template:${template.uriTemplate}`,
    label: template.name || template.uriTemplate,
    kind: 'resource',
    tone: 'resource',
    detail: template.uriTemplate,
  };
}

function promptLeaf(prompt: Prompt): Leaf {
  return {
    key: `prompt:${prompt.name}`,
    label: prompt.name,
    kind: 'prompt',
    tone: 'prompt',
    detail: prompt.description,
    select: { kind: 'prompt', name: prompt.name },
  };
}

function buildGroups(detail: ServerDetail): Group[] {
  const groups: Group[] = [];

  if (detail.tools.length) {
    groups.push({
      id: 'tools',
      label: 'Tools',
      tone: 'tool',
      leaves: detail.tools.map(toolLeaf),
    });
  }

  const resources = [...detail.resources.map(resourceLeaf), ...detail.resourceTemplates.map(templateLeaf)];
  if (resources.length) {
    groups.push({ id: 'resources', label: 'Resources', tone: 'resource', leaves: resources });
  }

  if (detail.prompts.length) {
    groups.push({
      id: 'prompts',
      label: 'Prompts',
      tone: 'prompt',
      leaves: detail.prompts.map(promptLeaf),
    });
  }

  return groups;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A cubic curve from a parent's right edge to a child's left edge. */
function connector(x1: number, y1: number, x2: number, y2: number, dim: boolean): SVGElement {
  const mid = x1 + (x2 - x1) / 2;
  return svg('path', {
    d: `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`,
    class: `map-edge${dim ? ' map-edge-dim' : ''}`,
    fill: 'none',
  });
}

export const mapView: ViewDefinition = {
  id: 'map',
  label: 'Map',
  glyph: '⊞',

  async render(ctx) {
    const server = ctx.currentServer();
    const store = scratch(ctx);

    if (!server) {
      return emptyState('No server selected.', 'Add a server from the MCP Lab sidebar.');
    }

    if (server.status !== 'connected') {
      return emptyState(
        `${server.name} is ${server.status}.`,
        server.error ?? 'Connect the server to map what it exposes.',
      );
    }

    // Refetched whenever the catalog moves, which is what makes the map live:
    // a list_changed notification clears this and the new shape is drawn.
    if (!store.detail || store.detailId !== server.id) {
      store.detail = await ctx.rpc.call<ServerDetail>('serverDetail', { serverId: server.id });
      store.detailId = server.id;
    }

    const detail = store.detail;
    const groups = buildGroups(detail);

    // Anything not in the previous pass is new. The first look at a server is
    // not "everything is new", so the baseline is recorded silently.
    const keys = groups.flatMap((group) => group.leaves.map((leaf) => leaf.key));
    const changed = diffCatalogKeys(store.seen[server.id], keys);
    store.fresh = changed.added;
    const removed = changed.removed.length;
    store.seen[server.id] = keys;

    const layout = h('div', { class: 'map-view' });
    layout.appendChild(renderToolbar(ctx, detail, store, removed));

    if (!groups.length) {
      layout.appendChild(
        emptyState(
          `${server.name} exposes nothing yet.`,
          'It connected and advertised no tools, resources or prompts.',
        ),
      );
      return layout;
    }

    layout.appendChild(renderTree(ctx, detail, groups, store));
    layout.appendChild(renderLegend());
    return layout;
  },
};

function renderToolbar(
  ctx: AppContext,
  detail: ServerDetail,
  store: MapScratch,
  removed: number,
): HTMLElement {
  const counts = [
    `${detail.tools.length} tools`,
    `${detail.resources.length + detail.resourceTemplates.length} resources`,
    `${detail.prompts.length} prompts`,
    // The protocol revision used to sit inside the server node, where a long
    // host name ran straight through it.
    detail.protocolVersion,
  ]
    .filter(Boolean)
    .join(' · ');

  return h(
    'div',
    { class: 'toolbar map-toolbar' },
    h('span', { class: 'map-title' }, detail.serverInfo?.name ?? detail.name),
    h('span', { class: 'muted' }, counts),
    store.fresh.length
      ? h('span', { class: 'badge badge-new' }, `${store.fresh.length} new`)
      : null,
    removed ? h('span', { class: 'badge badge-warn' }, `${removed} gone`) : null,
    h('span', { class: 'spacer' }),
    h(
      'button',
      {
        class: 'btn-ghost',
        title: 'Refetch the catalog from the server',
        onClick: async () => {
          await ctx.rpc.call('refreshCatalog', { serverId: detail.id });
          store.detail = undefined;
          await ctx.reload();
        },
      },
      'Refresh',
    ),
  );
}

function renderTree(
  ctx: AppContext,
  detail: ServerDetail,
  groups: Group[],
  store: MapScratch,
): HTMLElement {
  // Lay the leaves out first; parents then centre on the children they own.
  let row = 0;
  const placed: Array<{ group: Group; y: number; leaves: Array<{ leaf: Leaf; y: number }>; extra: number }> = [];

  for (const group of groups) {
    const collapsed = store.groups[group.id] === true;
    const visible = collapsed ? [] : group.leaves.slice(0, MAX_LEAVES);
    const extra = collapsed ? group.leaves.length : Math.max(0, group.leaves.length - visible.length);

    const leaves = visible.map((leaf) => ({ leaf, y: PAD_Y + row++ * ROW_H }));
    if (extra > 0) row++;

    const span = leaves.length
      ? [leaves[0].y, leaves[leaves.length - 1].y + (extra ? ROW_H : 0)]
      : [PAD_Y + row * ROW_H, PAD_Y + row * ROW_H];
    if (!leaves.length) row++;

    placed.push({ group, y: (span[0] + span[1]) / 2, leaves, extra });
    row += 1; // breathing room between groups
  }

  const height = PAD_Y * 2 + row * ROW_H;
  const width = COL_LEAF + LEAF_W + 16;
  const serverY = placed.length ? (placed[0].y + placed[placed.length - 1].y) / 2 : height / 2;

  const canvas = svg('svg', {
    class: 'map-canvas',
    viewBox: `0 0 ${width} ${height}`,
    width: String(width),
    height: String(height),
    role: 'img',
    'aria-label': `Capability map for ${detail.name}`,
  });

  // Edges first, so nodes paint over them.
  for (const entry of placed) {
    canvas.appendChild(
      connector(COL_SERVER + SERVER_W, serverY, COL_GROUP, entry.y, false),
    );
    for (const { y } of entry.leaves) {
      canvas.appendChild(connector(COL_GROUP + GROUP_W, entry.y, COL_LEAF, y, false));
    }
    if (entry.extra > 0 && entry.leaves.length) {
      const y = entry.leaves[entry.leaves.length - 1].y + ROW_H;
      canvas.appendChild(connector(COL_GROUP + GROUP_W, entry.y, COL_LEAF, y, true));
    }
  }

  canvas.appendChild(
    node({
      x: COL_SERVER,
      y: serverY,
      width: SERVER_W,
      label: truncate(detail.serverInfo?.name ?? detail.name, 20),
      tone: 'server',
    }),
  );

  for (const entry of placed) {
    const collapsed = store.groups[entry.group.id] === true;
    canvas.appendChild(
      node({
        x: COL_GROUP,
        y: entry.y,
        width: GROUP_W,
        label: `${entry.group.label} (${entry.group.leaves.length})`,
        tone: entry.group.tone,
        title: collapsed ? 'Click to expand' : 'Click to collapse',
        onClick: () => {
          store.groups[entry.group.id] = !collapsed;
          ctx.refresh();
        },
      }),
    );

    for (const { leaf, y } of entry.leaves) {
      canvas.appendChild(
        node({
          x: COL_LEAF,
          y,
          width: LEAF_W,
          label: truncate(leaf.label, 30),
          tone: leaf.tone,
          fresh: store.fresh.includes(leaf.key),
          title: leaf.detail ? `${leaf.label}\n\n${leaf.detail}` : leaf.label,
          onClick: leaf.select
            ? () => ctx.navigate('explorer', { selection: leaf.select })
            : undefined,
        }),
      );
    }

    if (entry.extra > 0) {
      const y = entry.leaves.length
        ? entry.leaves[entry.leaves.length - 1].y + ROW_H
        : entry.y;
      canvas.appendChild(
        node({
          x: COL_LEAF,
          y,
          width: LEAF_W,
          label: `+${entry.extra} more`,
          tone: 'more',
          title: 'Open the explorer to see the rest',
          onClick: () => ctx.navigate('explorer'),
        }),
      );
    }
  }

  return h('div', { class: 'map-canvas-wrap' }, canvas as unknown as HTMLElement);
}

interface NodeSpec {
  x: number;
  y: number;
  width: number;
  label: string;
  sub?: string;
  tone: string;
  fresh?: boolean;
  title?: string;
  onClick?: () => void;
}

function node(spec: NodeSpec): SVGElement {
  const group = svg('g', {
    class: `map-node map-node-${spec.tone}${spec.onClick ? ' map-node-clickable' : ''}${
      spec.fresh ? ' map-node-fresh' : ''
    }`,
    transform: `translate(${spec.x}, ${spec.y - NODE_H / 2})`,
    ...(spec.onClick ? { onClick: spec.onClick, role: 'button', tabindex: '0' } : {}),
  });

  if (spec.title) {
    group.appendChild(svg('title', null, spec.title));
  }

  group.appendChild(
    svg('rect', {
      class: 'map-node-box',
      width: String(spec.width),
      height: String(NODE_H),
      rx: '4',
    }),
  );

  // A left rule carries the tone, so the fill can stay theme-neutral and the
  // whole thing still reads in a light, dark or high-contrast theme.
  group.appendChild(
    svg('rect', { class: 'map-node-rule', width: '3', height: String(NODE_H), rx: '1.5' }),
  );

  group.appendChild(
    svg(
      'text',
      { class: 'map-node-label', x: '10', y: String(NODE_H / 2 + 4) },
      spec.label,
    ),
  );

  if (spec.sub) {
    group.appendChild(
      svg(
        'text',
        {
          class: 'map-node-sub',
          x: String(spec.width - 8),
          y: String(NODE_H / 2 + 4),
          'text-anchor': 'end',
        },
        spec.sub,
      ),
    );
  }

  if (spec.fresh) {
    group.appendChild(
      svg('circle', { class: 'map-node-dot', cx: String(spec.width - 8), cy: '10', r: '3.5' }),
    );
  }

  return group;
}

function renderLegend(): HTMLElement {
  const item = (tone: string, label: string) =>
    h('span', { class: 'map-legend-item' }, h('span', { class: `map-swatch map-swatch-${tone}` }), label);

  return h(
    'div',
    { class: 'map-legend muted' },
    item('read', 'read'),
    item('write', 'write'),
    item('destructive', 'destructive'),
    item('resource', 'resource'),
    item('prompt', 'prompt'),
    h('span', { class: 'spacer' }),
    h('span', null, 'Ringed nodes appeared since the last catalog change.'),
  );
}
