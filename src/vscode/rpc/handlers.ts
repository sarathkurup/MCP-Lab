import * as vscode from 'vscode';
import { diagnose } from '../../core/doctor';
import { classifyTool, guard } from '../../core/environments';
import { ValidationFailure } from '../../core/execution';
import { lint } from '../../core/linter';
import { TestRunner, type SuiteResult, type TestSuite } from '../../core/testing';
import type { ExecutionView } from '../../shared/viewModels';
import type { Workbench } from '../Workbench';

/**
 * Every capability the webview can invoke. Each phase adds methods here rather
 * than inventing new message plumbing.
 */
export function registerRpcHandlers(workbench: Workbench): void {
  const { router } = workbench.panel;

  // -- snapshot & catalog ----------------------------------------------------

  router.on('snapshot', () => workbench.snapshot());

  router.on('serverDetail', (params) => {
    const { serverId } = params as { serverId: string };
    return workbench.detail(serverId);
  });

  router.on('connect', async (params) => {
    const { serverId } = params as { serverId: string };
    await workbench.manager.connect(serverId);
    return workbench.summarize(serverId);
  });

  router.on('disconnect', async (params) => {
    const { serverId } = params as { serverId: string };
    await workbench.manager.disconnect(serverId);
    return workbench.summarize(serverId);
  });

  router.on('refreshCatalog', async (params) => {
    const { serverId } = params as { serverId: string };
    await workbench.manager.get(serverId)?.refreshCatalog();
    return workbench.detail(serverId);
  });

  // -- execution -------------------------------------------------------------

  router.on('executeTool', async (params) => {
    const { serverId, name, args, skipValidation } = params as {
      serverId: string;
      name: string;
      args: unknown;
      skipValidation?: boolean;
    };

    const guarded = await confirmIfRisky(workbench, serverId, name);
    if (!guarded) {
      throw new Error('Cancelled.');
    }

    try {
      const result = await workbench.execution.callTool(serverId, name, args, {
        skipValidation,
      });
      return toView(result);
    } catch (err) {
      if (err instanceof ValidationFailure) {
        throw new Error(err.message);
      }
      throw err;
    }
  });

  router.on('readResource', async (params) => {
    const { serverId, uri } = params as { serverId: string; uri: string };
    return toView(await workbench.execution.readResource(serverId, uri));
  });

  router.on('getPrompt', async (params) => {
    const { serverId, name, args } = params as {
      serverId: string;
      name: string;
      args: Record<string, string>;
    };
    return toView(await workbench.execution.getPrompt(serverId, name, args));
  });

  router.on('replay', async (params) => {
    const { historyId } = params as { historyId: string };
    return toView(await workbench.execution.replay(historyId));
  });

  // -- history ---------------------------------------------------------------

  router.on('history', (params) => {
    const { serverId, search } = (params ?? {}) as { serverId?: string; search?: string };
    return workbench.history.list({ serverId, search });
  });

  router.on('clearHistory', (params) => {
    const { serverId } = (params ?? {}) as { serverId?: string };
    workbench.history.clear(serverId);
    return true;
  });

  router.on('saveResponse', async (params) => {
    const { historyId } = params as { historyId: string };
    const entry = workbench.history.get(historyId);
    if (!entry) {
      throw new Error('That invocation is no longer in history.');
    }
    const target = await vscode.window.showSaveDialog({
      filters: { JSON: ['json'] },
      saveLabel: 'Save response',
      defaultUri: vscode.Uri.file(`${entry.name.replace(/[^\w.-]/g, '_')}-response.json`),
    });
    if (!target) {
      return false;
    }
    const payload = JSON.stringify(entry.error ?? entry.output, null, 2);
    await vscode.workspace.fs.writeFile(target, Buffer.from(payload, 'utf8'));
    void vscode.window.showInformationMessage(`Saved to ${target.fsPath}`);
    return true;
  });

  // -- trace & logs ----------------------------------------------------------

  router.on('trace', (params) => {
    const { serverId } = (params ?? {}) as { serverId?: string };
    return workbench.trace.list(serverId);
  });

  router.on('clearTrace', (params) => {
    const { serverId } = (params ?? {}) as { serverId?: string };
    workbench.trace.clear(serverId);
    return true;
  });

  router.on('logs', (params) => {
    const { serverId } = (params ?? {}) as { serverId?: string };
    return workbench.logs.query({ serverId });
  });

  router.on('clearLogs', (params) => {
    const { serverId } = (params ?? {}) as { serverId?: string };
    workbench.logs.clear(serverId);
    return true;
  });

  // -- analytics -------------------------------------------------------------

  router.on('analytics', (params) => {
    const { serverId } = (params ?? {}) as { serverId?: string };
    return workbench.history.stats(serverId);
  });

  // -- environments ----------------------------------------------------------

  router.on('setEnvironment', async (params) => {
    const { id } = params as { id: string };
    await workbench.setEnvironment(id);
    return workbench.snapshot();
  });

  // -- tests -----------------------------------------------------------------

  router.on('tests', async () => {
    const suites = await workbench.tests.discover();
    return suites;
  });

  router.on('runTests', async (params) => {
    const { serverId, sourceUri } = (params ?? {}) as {
      serverId?: string;
      sourceUri?: string;
    };
    const runner = new TestRunner(workbench.execution);
    const suites: TestSuite[] = sourceUri
      ? [workbench.tests.get(sourceUri)].filter((s): s is TestSuite => !!s)
      : workbench.tests.list();

    const results: SuiteResult[] = [];
    for (const suite of suites) {
      const target = serverId ?? (await workbench.resolveTestServer(suite, suite.tests[0] ?? { name: '' }));
      if (!target) {
        continue;
      }
      results.push(
        await runner.runSuite(suite, target, {
          onResult: (result) => workbench.panel.emit('test-result', result),
        }),
      );
    }
    return results;
  });

  router.on('openTestFile', async (params) => {
    const { sourceUri } = params as { sourceUri: string };
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(sourceUri));
    await vscode.window.showTextDocument(doc);
    return true;
  });

  router.on('generateTests', async (params) => {
    const { serverId, toolName } = params as { serverId: string; toolName: string };
    await vscode.commands.executeCommand('mcpWorkbench.generateTests', serverId, toolName);
    return true;
  });

  // -- doctor & linter -------------------------------------------------------

  router.on('diagnose', async (params) => {
    const { serverId, probe } = params as { serverId: string; probe?: boolean };
    const connection = workbench.manager.get(serverId);
    if (!connection) {
      throw new Error(`Unknown server "${serverId}"`);
    }
    return diagnose(connection, {
      probe,
      testedTargets: workbench.tests.list().length ? workbench.tests.testedTargets() : undefined,
      hasCredential: !!(await workbench.store.getAuthToken(serverId)),
    });
  });

  router.on('lint', async (params) => {
    const { serverId, publish } = params as { serverId: string; publish?: boolean };
    const connection = workbench.manager.get(serverId);
    if (!connection) {
      throw new Error(`Unknown server "${serverId}"`);
    }
    const findings = lint({
      tools: connection.catalog.tools,
      resources: connection.catalog.resources,
      prompts: connection.catalog.prompts,
      testedTargets: workbench.tests.list().length ? workbench.tests.testedTargets() : undefined,
    });
    if (publish) {
      const anchored = await workbench.lintDiagnostics.publish(findings, connection.config.name);
      return { findings, anchored };
    }
    return { findings, anchored: 0 };
  });

  router.on('runFix', async (params) => {
    const { command, serverId } = params as { command: string; serverId?: string };
    await vscode.commands.executeCommand(command, serverId ? { serverId } : undefined);
    return true;
  });

  // -- placeholders fulfilled by later phases --------------------------------

  router.on('analyzeFailure', async (params) => {
    const { historyId } = params as { historyId: string };
    await vscode.commands.executeCommand('mcpWorkbench.analyzeFailure', historyId);
    return true;
  });

  router.on('saveAsTest', async (params) => {
    const { historyId } = params as { historyId: string };
    await vscode.commands.executeCommand('mcpWorkbench.saveAsTest', historyId);
    return true;
  });
}

function toView(result: { entry: ExecutionView['entry']; error?: unknown }): ExecutionView {
  return { entry: result.entry, ok: !result.error };
}

/**
 * The single gate every invocation passes through: classify the tool, ask the
 * environment what that means, and confirm when it matters. Production writes
 * are stopped even when the tool carries no annotations at all.
 */
export async function confirmIfRisky(
  workbench: Workbench,
  serverId: string,
  toolName: string,
): Promise<boolean> {
  const connection = workbench.manager.get(serverId);
  const tool = connection?.catalog.tools.find((t) => t.name === toolName);
  if (!tool) {
    return true;
  }

  const environment = workbench.activeEnvironment;
  const risk = classifyTool(tool);
  const decision = guard(risk, environment?.tier);
  if (!decision.confirm) {
    return true;
  }

  const target =
    connection?.config.transport === 'http' ? connection.config.url : connection?.config.command;
  const choice = await vscode.window.showWarningMessage(
    decision.severity === 'danger'
      ? `⚠️ ${toolName} — ${environment?.name ?? 'current environment'}`
      : `Run "${toolName}"?`,
    {
      modal: true,
      detail: [
        decision.reason,
        '',
        `Server: ${connection?.config.name}`,
        `Environment: ${environment?.name ?? 'none'}`,
        `Target: ${target ?? 'unknown'}`,
        `Classification: ${risk}`,
      ].join('\n'),
    },
    'Run anyway',
  );
  return choice === 'Run anyway';
}
