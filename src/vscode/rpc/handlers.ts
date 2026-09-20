import * as vscode from 'vscode';
import { diagnose } from '../../core/doctor';
import { classifyTool, guard } from '../../core/environments';
import { ValidationFailure } from '../../core/execution';
import { lint } from '../../core/linter';
import { scanSecurity } from '../../core/security';
import { TestRunner, type SuiteResult, type TestSuite } from '../../core/testing';
import { validateWorkflow, WorkflowRunner } from '../../core/workflows';
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
    await vscode.commands.executeCommand('mcpilot.generateTests', serverId, toolName);
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

  // -- security --------------------------------------------------------------

  router.on('securityScan', async (params) => {
    const { serverId } = params as { serverId: string };
    const connection = workbench.manager.get(serverId);
    if (!connection) {
      throw new Error(`Unknown server "${serverId}"`);
    }
    return scanSecurity({
      config: connection.config,
      tools: connection.catalog.tools,
      resources: connection.catalog.resources,
      prompts: connection.catalog.prompts,
      logs: workbench.logs.query({ serverId }),
      history: workbench.history.list({ serverId }),
      hasStoredCredential: !!(await workbench.store.getAuthToken(serverId)),
      environmentTier: workbench.activeEnvironment?.tier,
    });
  });

  // -- comparison ------------------------------------------------------------

  router.on('compare', async (params) => {
    const { leftId, rightId } = params as { leftId: string; rightId: string };
    return workbench.compare(leftId, rightId);
  });

  // -- documentation ---------------------------------------------------------

  router.on('generateDocs', async (params) => {
    const { serverId } = params as { serverId: string };
    await vscode.commands.executeCommand('mcpilot.generateDocs', { serverId });
    return true;
  });

  // -- catalog & search ------------------------------------------------------

  router.on('catalog', () => workbench.catalog());

  router.on('search', (params) => {
    const { query } = params as { query: string };
    return workbench.search(query);
  });

  router.on('openExternal', async (params) => {
    const { url } = params as { url: string };
    // Only ever opens a link the user put in their own server configuration.
    await vscode.env.openExternal(vscode.Uri.parse(url));
    return true;
  });

  // -- workflows -------------------------------------------------------------

  router.on('workflows', async () => {
    await workbench.workflows.discover();
    return workbench.workflows.list();
  });

  router.on('runWorkflow', async (params) => {
    const { workflowId, serverId } = params as { workflowId: string; serverId?: string };
    const workflow = workbench.workflows.get(workflowId);
    if (!workflow) {
      throw new Error(`Unknown workflow "${workflowId}"`);
    }

    const problems = validateWorkflow(workflow);
    if (problems.length > 0) {
      throw new Error(`Workflow is not runnable:\n${problems.map((p) => `  • ${p}`).join('\n')}`);
    }

    // Every tool a workflow touches goes through the same risk gate as a manual call.
    const fallbackId = serverId ?? workbench.manager.list().find((c) => c.status === 'connected')?.id;
    for (const step of workflow.steps) {
      if (step.kind !== 'tool' || !step.tool) {
        continue;
      }
      const target = workbench.resolveServerByName(step.server ?? workflow.server) ?? fallbackId;
      if (target && !(await confirmIfRisky(workbench, target, step.tool))) {
        throw new Error('Cancelled.');
      }
    }

    const runner = new WorkflowRunner(workbench.execution, (name) =>
      workbench.resolveServerByName(name) ?? fallbackId,
    );
    const subscription = runner.onDidCompleteStep((step) =>
      workbench.panel.emit('workflow-step', step),
    );
    try {
      return await runner.run(workflow, { environment: workbench.activeEnvironment?.name });
    } finally {
      subscription.dispose();
    }
  });

  // -- recording -------------------------------------------------------------

  router.on('recordingState', () => ({
    recording: workbench.recorder.isRecording,
    entries: workbench.recorder.recorded,
  }));

  router.on('startRecording', (params) => {
    const { serverId } = (params ?? {}) as { serverId?: string };
    workbench.recorder.start(serverId ? { serverId } : undefined);
    return true;
  });

  router.on('stopRecording', () => {
    workbench.recorder.stop();
    return workbench.recorder.recorded;
  });

  router.on('dropRecorded', (params) => {
    const { id } = params as { id: string };
    workbench.recorder.remove(id);
    return workbench.recorder.recorded;
  });

  router.on('replayRecording', async () => {
    const replayed = await workbench.recorder.replayAll();
    return replayed.length;
  });

  router.on('saveRecordingAsWorkflow', async () => {
    const name = await vscode.window.showInputBox({
      title: 'Save recording as workflow',
      prompt: 'Workflow name',
      value: 'Recorded workflow',
    });
    if (!name) {
      return false;
    }
    const workflow = workbench.recorder.toWorkflow(name);
    const uri = await workbench.workflows.save(workflow);
    const open = await vscode.window.showInformationMessage(
      `Saved ${vscode.workspace.asRelativePath(uri)} with ${workflow.steps.length} step(s).`,
      'Open',
    );
    if (open === 'Open') {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    }
    return true;
  });

  router.on('saveRecordingAsTests', async () => {
    const tests = workbench.recorder.toTests();
    if (tests.length === 0) {
      throw new Error('Nothing was recorded.');
    }
    const uri = await workbench.tests.append('recorded', tests);
    void vscode.window.showInformationMessage(
      `Saved ${tests.length} test(s) to ${vscode.workspace.asRelativePath(uri)}.`,
    );
    return true;
  });

  // -- placeholders fulfilled by later phases --------------------------------

  router.on('analyzeFailure', async (params) => {
    const { historyId } = params as { historyId: string };
    await vscode.commands.executeCommand('mcpilot.analyzeFailure', historyId);
    return true;
  });

  router.on('saveAsTest', async (params) => {
    const { historyId } = params as { historyId: string };
    await vscode.commands.executeCommand('mcpilot.saveAsTest', historyId);
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
