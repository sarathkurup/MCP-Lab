import type { RpcClient } from '../shared/rpc';
import type { ServerSummary, McpLabSnapshot } from '../shared/viewModels';

export interface ViewDefinition {
  id: string;
  label: string;
  glyph: string;
  /** Rendered fresh whenever the view is shown or the app asks for a refresh. */
  render(ctx: AppContext): HTMLElement | Promise<HTMLElement>;
  /** Optional live hook so a mounted view can append streamed rows. */
  onEvent?(ctx: AppContext, name: string, payload: unknown): void;
}

export interface AppState {
  activeView: string;
  serverId?: string;
  /** Explorer selection. */
  selection?: { kind: 'tool' | 'resource' | 'prompt'; name: string };
  /** Per-view scratch space that must survive a re-render. */
  scratch: Record<string, unknown>;
}

export interface AppContext {
  rpc: RpcClient;
  state: AppState;
  snapshot: McpLabSnapshot;
  /** Re-renders the active view. */
  refresh(): void;
  /** Re-reads the snapshot from the extension, then re-renders. */
  reload(): Promise<void>;
  navigate(viewId: string, state?: Partial<AppState>): void;
  currentServer(): ServerSummary | undefined;
  toast(message: string, kind?: 'info' | 'error'): void;
}
