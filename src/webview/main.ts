import { RpcClient, type HostMessage, type ViewMessage } from '../shared/rpc';
import type { ServerSummary, WorkbenchSnapshot } from '../shared/viewModels';
import type { AppContext, AppState, ViewDefinition } from './app';
import { clear, h } from './dom';
import { analyticsView } from './views/analytics';
import { catalogView } from './views/catalog';
import { compareView } from './views/compare';
import { doctorView } from './views/doctor';
import { explorerView } from './views/explorer';
import { historyView } from './views/history';
import { logsView } from './views/logs';
import { securityView } from './views/security';
import { testsView } from './views/tests';
import { traceView } from './views/trace';
import { workflowsView } from './views/workflows';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();
const rpc = new RpcClient((message: ViewMessage) => vscode.postMessage(message));

window.addEventListener('message', (event) => {
  const message = event.data as HostMessage;
  rpc.handleMessage(message);
  if (message.channel === 'event') {
    handleEvent(message.name, message.payload);
  }
});

const VIEWS: ViewDefinition[] = [
  explorerView,
  historyView,
  testsView,
  doctorView,
  traceView,
  workflowsView,
  logsView,
  analyticsView,
  securityView,
  compareView,
  catalogView,
];

const persisted = (vscode.getState() ?? {}) as Partial<AppState>;

const state: AppState = {
  activeView: persisted.activeView ?? 'explorer',
  serverId: persisted.serverId,
  selection: undefined,
  scratch: {},
};

let snapshot: WorkbenchSnapshot = { servers: [], environments: [] };
let rendering = false;

const root = document.getElementById('root')!;
const toastHost = h('div', { class: 'toast-host' });
document.body.appendChild(toastHost);

const ctx: AppContext = {
  rpc,
  state,
  get snapshot() {
    return snapshot;
  },
  refresh: () => void renderActive(),
  reload: async () => {
    snapshot = await rpc.call<WorkbenchSnapshot>('snapshot');
    reconcileSelection();
    await renderActive();
  },
  navigate: (viewId, patch) => {
    state.activeView = viewId;
    Object.assign(state, patch ?? {});
    persist();
    void renderActive();
  },
  currentServer: () => snapshot.servers.find((s) => s.id === state.serverId),
  toast,
};

function persist(): void {
  vscode.setState({ activeView: state.activeView, serverId: state.serverId });
}

function reconcileSelection(): void {
  if (!state.serverId || !snapshot.servers.some((s) => s.id === state.serverId)) {
    state.serverId = snapshot.servers[0]?.id;
  }
}

function handleEvent(name: string, payload: unknown): void {
  if (name === 'servers-changed') {
    snapshot = payload as WorkbenchSnapshot;
    reconcileSelection();
    renderChrome();
    // The catalog can change shape underneath the explorer, so drop its cache.
    delete (state.scratch as Record<string, unknown>).explorer;
    void renderActive();
    return;
  }
  if (name === 'focus') {
    const target = payload as { serverId?: string; view?: string; selection?: AppState['selection'] };
    if (target.serverId) {
      state.serverId = target.serverId;
    }
    if (target.selection) {
      state.selection = target.selection;
    }
    if (target.view) {
      state.activeView = target.view;
    }
    delete (state.scratch as Record<string, unknown>).explorer;
    persist();
    void renderActive();
    return;
  }
  if (name === 'history-changed') {
    if (state.activeView === 'history' || state.activeView === 'analytics') {
      void renderActive();
    }
    return;
  }

  const view = VIEWS.find((v) => v.id === state.activeView);
  view?.onEvent?.(ctx, name, payload);
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

const header = h('header', { class: 'app-header' });
const nav = h('nav', { class: 'app-nav' });
const main = h('main', { class: 'app-main' });
root.append(header, nav, main);

function renderChrome(): void {
  clear(header);
  clear(nav);

  const serverSelect = h('select', {
    class: 'server-select',
    onChange: (event) => {
      state.serverId = (event.target as HTMLSelectElement).value;
      state.selection = undefined;
      delete (state.scratch as Record<string, unknown>).explorer;
      persist();
      void renderActive();
    },
  });

  if (snapshot.servers.length === 0) {
    serverSelect.appendChild(h('option', null, 'No servers configured'));
    serverSelect.disabled = true;
  } else {
    for (const server of snapshot.servers) {
      const option = h('option', { value: server.id }, `${statusGlyph(server)} ${server.name}`);
      option.selected = server.id === state.serverId;
      serverSelect.appendChild(option);
    }
  }

  const current = ctx.currentServer();

  const headerChildren: Array<Node | null> = [
    h('span', { class: 'app-title' }, 'MCP Lab'),
    serverSelect,
    current
      ? h(
          'button',
          {
            class: 'btn-ghost',
            onClick: async () => {
              const method = current.status === 'connected' ? 'disconnect' : 'connect';
              try {
                await rpc.call(method, { serverId: current.id });
              } catch (err) {
                toast((err as Error).message, 'error');
              }
            },
          },
          current.status === 'connected' ? 'Disconnect' : 'Connect',
        )
      : null,
    current
      ? h(
          'button',
          {
            class: 'btn-ghost',
            title: 'Re-read tools, resources and prompts',
            onClick: async () => {
              await rpc.call('refreshCatalog', { serverId: current.id });
              delete (state.scratch as Record<string, unknown>).explorer;
              await ctx.reload();
            },
          },
          'Refresh',
        )
      : null,
    h('span', { class: 'spacer' }),
    renderEnvironmentPicker(),
  ];
  header.append(...headerChildren.filter((node): node is Node => node !== null));

  for (const view of VIEWS) {
    nav.appendChild(
      h(
        'button',
        {
          class: `nav-item${view.id === state.activeView ? ' active' : ''}`,
          onClick: () => {
            state.activeView = view.id;
            persist();
            renderChrome();
            void renderActive();
          },
        },
        h('span', { class: 'nav-glyph' }, view.glyph),
        h('span', null, view.label),
      ),
    );
  }
}

function renderEnvironmentPicker(): HTMLElement | null {
  if (snapshot.environments.length === 0) {
    return null;
  }
  const active = snapshot.environments.find((e) => e.id === snapshot.activeEnvironmentId);
  const select = h('select', {
    class: `env-select tier-${active?.tier ?? 'dev'}`,
    onChange: async (event) => {
      await rpc.call('setEnvironment', { id: (event.target as HTMLSelectElement).value });
      await ctx.reload();
      renderChrome();
    },
  });
  for (const env of snapshot.environments) {
    const option = h('option', { value: env.id }, env.name);
    option.selected = env.id === snapshot.activeEnvironmentId;
    select.appendChild(option);
  }
  return select;
}

function statusGlyph(server: ServerSummary): string {
  switch (server.status) {
    case 'connected':
      return '●';
    case 'connecting':
      return '◐';
    case 'error':
      return '▲';
    default:
      return '○';
  }
}

async function renderActive(): Promise<void> {
  if (rendering) {
    return;
  }
  rendering = true;
  const view = VIEWS.find((v) => v.id === state.activeView) ?? VIEWS[0];
  try {
    const content = await view.render(ctx);
    clear(main);
    main.appendChild(content);
  } catch (err) {
    clear(main);
    main.appendChild(
      h(
        'div',
        { class: 'empty-state' },
        h('h2', null, 'Something went wrong rendering this view'),
        h('p', null, (err as Error).message),
      ),
    );
  } finally {
    rendering = false;
  }
  renderNavActive();
}

function renderNavActive(): void {
  for (const [index, child] of [...nav.children].entries()) {
    child.classList.toggle('active', VIEWS[index]?.id === state.activeView);
  }
}

function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  const el = h('div', { class: `toast toast-${kind}` }, message);
  toastHost.appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 8000 : 3000);
}

async function boot(): Promise<void> {
  snapshot = await rpc.call<WorkbenchSnapshot>('snapshot');
  reconcileSelection();
  renderChrome();
  await renderActive();
}

void boot();
