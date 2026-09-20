import * as vscode from 'vscode';
import { parseSuite, type TestCase, type TestSuite } from '../../core/testing';

const TEST_GLOB = '**/*.mcp-test.json';
const LEGACY_GLOB = '**/mcp-tests/**/*.json';

/**
 * Discovers and writes declarative test suites in the workspace. Tests are
 * plain JSON files so they can be reviewed, diffed and run in CI without
 * McpLab being installed.
 */
export class TestRepository implements vscode.Disposable {
  private readonly suites = new Map<string, TestSuite>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    for (const glob of [TEST_GLOB, LEGACY_GLOB]) {
      const watcher = vscode.workspace.createFileSystemWatcher(glob);
      watcher.onDidCreate((uri) => void this.load(uri));
      watcher.onDidChange((uri) => void this.load(uri));
      watcher.onDidDelete((uri) => {
        this.suites.delete(uri.toString());
        this.changed.fire();
      });
      this.disposables.push(watcher);
    }
  }

  async discover(): Promise<TestSuite[]> {
    this.suites.clear();
    const files = [
      ...(await vscode.workspace.findFiles(TEST_GLOB, '**/node_modules/**')),
      ...(await vscode.workspace.findFiles(LEGACY_GLOB, '**/node_modules/**')),
    ];
    for (const uri of files) {
      await this.load(uri, true);
    }
    this.changed.fire();
    return this.list();
  }

  private async load(uri: vscode.Uri, quiet = false): Promise<void> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const raw = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
      const name = uri.path.split('/').pop() ?? 'suite';
      this.suites.set(uri.toString(), parseSuite(raw, name, uri.toString()));
      if (!quiet) {
        this.changed.fire();
      }
    } catch (err) {
      // A malformed suite must not take the whole discovery down.
      this.suites.set(uri.toString(), {
        name: uri.path.split('/').pop() ?? 'suite',
        tests: [],
        sourceUri: uri.toString(),
      });
      if (!quiet) {
        void vscode.window.showWarningMessage(
          `MCP Lab: could not read ${uri.fsPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  list(): TestSuite[] {
    return [...this.suites.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(sourceUri: string): TestSuite | undefined {
    return this.suites.get(sourceUri);
  }

  /** `tool:name` keys with at least one test, used by the linter and doctor. */
  testedTargets(): Set<string> {
    const targets = new Set<string>();
    for (const suite of this.suites.values()) {
      for (const test of suite.tests) {
        if (test.tool) {
          targets.add(`tool:${test.tool}`);
        }
        if (test.resource) {
          targets.add(`resource:${test.resource}`);
        }
        if (test.prompt) {
          targets.add(`prompt:${test.prompt}`);
        }
      }
    }
    return targets;
  }

  /**
   * Appends tests to a suite file, creating it if needed. Existing tests are
   * preserved so a generated batch never overwrites hand-written ones.
   */
  async append(
    fileName: string,
    tests: TestCase[],
    serverName?: string,
  ): Promise<vscode.Uri> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error('Open a folder before saving tests.');
    }
    const uri = vscode.Uri.joinPath(
      folder.uri,
      'mcp-tests',
      fileName.endsWith('.json') ? fileName : `${fileName}.mcp-test.json`,
    );

    let existing: TestSuite | undefined;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      existing = parseSuite(JSON.parse(Buffer.from(bytes).toString('utf8')), fileName, uri.toString());
    } catch {
      existing = undefined;
    }

    const merged: TestSuite = {
      name: existing?.name ?? fileName.replace(/\.(mcp-test\.)?json$/, ''),
      server: existing?.server ?? serverName,
      tests: [...(existing?.tests ?? []), ...tests],
    };

    const payload = JSON.stringify(
      { name: merged.name, server: merged.server, tests: merged.tests },
      null,
      2,
    );
    await vscode.workspace.fs.writeFile(uri, Buffer.from(payload, 'utf8'));
    await this.load(uri);
    return uri;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.changed.dispose();
  }
}
