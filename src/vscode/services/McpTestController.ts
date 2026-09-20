import * as vscode from 'vscode';
import { TestRunner, type TestCase, type TestSuite } from '../../core/testing';
import type { Workbench } from '../Workbench';

/**
 * Surfaces MCP suites in VS Code's own Test Explorer, so running them feels
 * like running any other test in the editor. The runner itself lives in core.
 */
export class McpTestController implements vscode.Disposable {
  private readonly controller: vscode.TestController;
  private readonly cases = new WeakMap<vscode.TestItem, TestCase>();
  private readonly suiteOf = new WeakMap<vscode.TestItem, TestSuite>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly workbench: Workbench) {
    this.controller = vscode.tests.createTestController('mcplab', 'MCP Tests');

    this.controller.resolveHandler = async () => {
      await this.workbench.tests.discover();
      this.rebuild();
    };

    this.controller.createRunProfile(
      'Run',
      vscode.TestRunProfileKind.Run,
      (request, token) => void this.run(request, token),
      true,
    );

    this.disposables.push(
      this.workbench.tests.onDidChange(() => this.rebuild()),
      this.controller,
    );
  }

  rebuild(): void {
    this.controller.items.replace(
      this.workbench.tests.list().map((suite) => this.buildSuiteItem(suite)),
    );
  }

  private buildSuiteItem(suite: TestSuite): vscode.TestItem {
    const uri = suite.sourceUri ? vscode.Uri.parse(suite.sourceUri) : undefined;
    const item = this.controller.createTestItem(suite.sourceUri ?? suite.name, suite.name, uri);
    this.suiteOf.set(item, suite);

    item.children.replace(
      suite.tests.map((test) => {
        const child = this.controller.createTestItem(
          `${suite.sourceUri ?? suite.name}::${test.name}`,
          test.name,
          uri,
        );
        child.description = test.tool ?? test.resource ?? test.prompt;
        this.cases.set(child, test);
        this.suiteOf.set(child, suite);
        return child;
      }),
    );
    return item;
  }

  private async run(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const run = this.controller.createTestRun(request);
    const runner = new TestRunner(this.workbench.execution);

    const queue: vscode.TestItem[] = [];
    if (request.include) {
      queue.push(...request.include);
    } else {
      this.controller.items.forEach((item) => queue.push(item));
    }

    const leaves: vscode.TestItem[] = [];
    while (queue.length) {
      const item = queue.pop()!;
      if (item.children.size > 0) {
        item.children.forEach((child) => queue.push(child));
      } else {
        leaves.push(item);
      }
    }

    for (const item of leaves) {
      if (token.isCancellationRequested) {
        break;
      }
      const test = this.cases.get(item);
      const suite = this.suiteOf.get(item);
      if (!test || !suite) {
        run.skipped(item);
        continue;
      }

      const serverId = await this.workbench.resolveTestServer(suite, test);
      if (!serverId) {
        run.errored(
          item,
          new vscode.TestMessage(
            `No connected MCP server matches "${test.server ?? suite.server ?? 'any'}".`,
          ),
        );
        continue;
      }

      run.started(item);
      const result = await runner.runCase(test, suite.name, serverId);

      if (result.status === 'passed') {
        run.passed(item, result.durationMs);
      } else if (result.status === 'skipped') {
        run.skipped(item);
      } else {
        const failures = result.assertions.filter((a) => !a.passed);
        const message = new vscode.TestMessage(
          result.message ?? failures.map((f) => f.message).join('\n') ?? 'Test failed',
        );
        // Expected/actual drive VS Code's inline diff view.
        const first = failures[0];
        if (first) {
          message.expectedOutput = JSON.stringify(
            first.assertion.equals ?? first.assertion.contains ?? first.assertion.matches,
            null,
            2,
          );
          message.actualOutput = JSON.stringify(first.actual, null, 2);
        }
        if (result.status === 'errored') {
          run.errored(item, message, result.durationMs);
        } else {
          run.failed(item, message, result.durationMs);
        }
      }
    }

    run.end();
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
