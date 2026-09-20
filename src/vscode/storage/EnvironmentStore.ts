import * as vscode from 'vscode';
import { DEFAULT_ENVIRONMENTS, type Environment } from '../../core/environments';

const ACTIVE_KEY = 'mcpilot.activeEnvironment';

/**
 * Environments are workspace-scoped: the same repository checked out twice
 * should not share a "currently pointing at PROD" flag with the other copy.
 */
export class EnvironmentStore {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  list(): Environment[] {
    const configured = vscode.workspace
      .getConfiguration('mcpilot')
      .get<Environment[]>('environments', []);
    const valid = configured.filter((e) => e && e.id && e.name);
    return valid.length > 0 ? valid : DEFAULT_ENVIRONMENTS;
  }

  get active(): Environment | undefined {
    const environments = this.list();
    const stored = this.context.workspaceState.get<string>(ACTIVE_KEY);
    return environments.find((e) => e.id === stored) ?? environments[0];
  }

  async setActive(id: string): Promise<void> {
    if (!this.list().some((e) => e.id === id)) {
      throw new Error(`Unknown environment "${id}"`);
    }
    await this.context.workspaceState.update(ACTIVE_KEY, id);
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }
}
