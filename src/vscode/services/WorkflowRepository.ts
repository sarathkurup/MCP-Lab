import * as vscode from 'vscode';
import { validateWorkflow, type Workflow } from '../../core/workflows';

const GLOB = '**/mcp-workflows/*.json';

/** Workflows are JSON files in the workspace, like tests: reviewable and diffable. */
export class WorkflowRepository implements vscode.Disposable {
  private readonly workflows = new Map<string, Workflow>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly watcher: vscode.FileSystemWatcher;

  constructor() {
    this.watcher = vscode.workspace.createFileSystemWatcher(GLOB);
    this.watcher.onDidCreate((uri) => void this.load(uri));
    this.watcher.onDidChange((uri) => void this.load(uri));
    this.watcher.onDidDelete((uri) => {
      this.workflows.delete(uri.toString());
      this.changed.fire();
    });
  }

  async discover(): Promise<Workflow[]> {
    this.workflows.clear();
    for (const uri of await vscode.workspace.findFiles(GLOB, '**/node_modules/**')) {
      await this.load(uri, true);
    }
    this.changed.fire();
    return this.list();
  }

  private async load(uri: vscode.Uri, quiet = false): Promise<void> {
    try {
      const raw = JSON.parse(
        Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'),
      ) as Workflow;
      const name = uri.path.split('/').pop() ?? 'workflow';
      const workflow: Workflow = {
        ...raw,
        id: raw.id ?? name.replace(/\.json$/, ''),
        name: raw.name ?? name.replace(/\.json$/, ''),
        steps: raw.steps ?? [],
        sourceUri: uri.toString(),
      };

      const problems = validateWorkflow(workflow);
      if (problems.length > 0 && !quiet) {
        void vscode.window.showWarningMessage(
          `Workflow "${workflow.name}" has problems: ${problems.join('; ')}`,
        );
      }

      this.workflows.set(uri.toString(), workflow);
      if (!quiet) {
        this.changed.fire();
      }
    } catch (err) {
      if (!quiet) {
        void vscode.window.showWarningMessage(
          `Could not read ${uri.fsPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  list(): Workflow[] {
    return [...this.workflows.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): Workflow | undefined {
    return this.list().find((workflow) => workflow.id === id);
  }

  async save(workflow: Workflow): Promise<vscode.Uri> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error('Open a folder before saving a workflow.');
    }
    const uri = vscode.Uri.joinPath(folder.uri, 'mcp-workflows', `${workflow.id}.json`);
    const payload = JSON.stringify(
      {
        id: workflow.id,
        name: workflow.name,
        description: workflow.description,
        server: workflow.server,
        steps: workflow.steps,
      },
      null,
      2,
    );
    await vscode.workspace.fs.writeFile(uri, Buffer.from(payload, 'utf8'));
    await this.load(uri);
    return uri;
  }

  dispose(): void {
    this.watcher.dispose();
    this.changed.dispose();
  }
}
