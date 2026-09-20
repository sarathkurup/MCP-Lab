import * as vscode from 'vscode';
import { diagnose } from '../../core/doctor';
import { classifyTool, guard } from '../../core/environments';
import { ValidationFailure } from '../../core/execution';
import { lint } from '../../core/linter';
import { scanSecurity } from '../../core/security';
import { TestRunner, type SuiteResult, type TestSuite } from '../../core/testing';
import { validateWorkflow, WorkflowRunner } from '../../core/workflows';
import type { ExecutionView } from '../../shared/viewModels';
import type { McpLab } from '../McpLab';

/**
 * Every capability the webview can invoke. Each phase adds methods here rather
 * than inventing new message plumbing.
 */
export function registerRpcHandlers(lab: McpLab): void {
  const { router } = lab.panel;

  // -- snapshot & catalog ----------------------------------------------------

  router.on('snapshot', () => lab.snapshot());

  router.on('serverDetail', (params) => {
    const { serverId } = params as { serverId: string };
    return lab.detail(serverId);
  });

  router.on('connect', async (params) => {
    const { serverId } = params as { serverId: string };
    await lab.manager.connect(serverId);
    return lab.summarize(serverId);
  });

  router.on('disconnect', async (params) => {
    const { serverId } = params as { serverId: string };
    await lab.manager.disconnect(serverId);
    return lab.summarize(serverId);
  });

  router.on('refreshCatalog', async (params) => {
    const { serverId } = params as { serverId: string };
    await lab.manager.get(serverId)?.refreshCatalog();
    return lab.detail(serverId);
  });

  // -- execution -------------------------------------------------------------

  router.on('executeTool', async (params) => {
    const { serverId, name, args, skipValidation } = params as {
      serverId: string;
      name: string;
      args: unknown;
      skipValidation?: boolean;
    };

    const guarded = await confirmIfRisky(lab, serverId, name);
    if (!guarded) {
      throw new Error('Cancelled.');
    }

    try {
      const result = await lab.execution.callTool(serverId, name, args, {
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
    return toView(await lab.execution.readResource(serverId, uri));
  });

  router.on('getPrompt', async (params) => {
    const { serverId, name, args } = params as {
      serverId: string;
      name: string;
      args: Record<string, string>;
    };
    return toView(await lab.execution.getPrompt(serverId, name, args));
  });

  router.on('replay', async (params) => {
    const { historyId } = params as { historyId: string };
    return toView(await lab.execution.replay(historyId));
  });

  // -- history ---------------------------------------------------------------

  router.on('history', (params) => {
    const { serverId, search } = (params ?? {}) as { serverId?: string; search?: string };
    return lab.history.list({ serverId, search });
  });

  router.on('clearHistory', (params) => {
    const { serverId } = (params ?? {}) as { serverId?: string };
    lab.history.clear(serverId);
    return true;
  });

  router.on('saveResponse', async (params) => {
    const { historyId } = params as { historyId: string };
    const entry = lab.history.get(historyId);
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
    return lab.trace.list(serverId);
  });

  router.on('clearTrace', (params) => {
    const { serverId } = (params ?? {}) as { serverId?: string };
    lab.trace.clear(serverId);
    return true;
  });

  router.on('logs', (params) => {
    const { serverId } = (params ?? {}) as { serverId?: string };
    return lab.logs.query({ serverId });
  });

  router.on('clearLogs', (params) => {
    const { serverId } = (params ?? {}) as { serverId?: string };
    lab.logs.clear(serverId);
    return true;
  });

  // -- analytics -------------------------------------------------------------

  router.on('analytics', (params) => {
    const { serverId } = (params ?? {}) as { serverId?: string };
    return lab.history.stats(serverId);
  });

  // -- environments ----------------------------------------------------------

  router.on('setEnvironment', async (params) => {
    const { id } = params as { id: string };
    await lab.setEnvironment(id);
    return lab.snapshot();
  });

  // -- tests -----------------------------------------------------------------

  router.on('tests', async () => {
    const suites = await lab.tests.discover();
    return suites;
  });

  router.on('runTests', async (params) => {
    const { serverId, sourceUri } = (params ?? {}) as {
      serverId?: string;
      sourceUri?: string;
    };
    const runner = new TestRunner(lab.execution);
    const suites: TestSuite[] = sourceUri
      ? [lab.tests.get(sourceUri)].filter((s): s is TestSuite => !!s)
      : lab.tests.list();

    const results: SuiteResult[] = [];
    for (const suite of suites) {
      const target = serverId ?? (await lab.resolveTestServer(suite, suite.tests[0] ?? { name: '' }));
      if (!target) {
        continue;
      }
      results.push(
        await runner.runSuite(suite, target, {
          onResult: (result) => lab.panel.emit('test-result', result),
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
    await vscode.commands.executeCommand('mcplab.generateTests', serverId, toolName);
    return true;
  });

  // -- doctor & linter -------------------------------------------------------

  router.on('diagnose', async (params) => {
    const { serverId, probe } = params as { serverId: string; probe?: boolean };
    const connection = lab.manager.get(serverId);
    if (!connection) {
      throw new Error(`Unknown server "${serverId}"`);
    }
    return diagnose(connection, {
      probe,
      testedTargets: lab.tests.list().length ? lab.tests.testedTargets() : undefined,
      hasCredential: !!(await lab.store.getAuthToken(serverId)),
    });
  });

  router.on('lint', async (params) => {
    const { serverId, publish } = params as { serverId: string; publish?: boolean };
    const connection = lab.manager.get(serverId);
    if (!connection) {
      throw new Error(`Unknown server "${serverId}"`);
    }
    const findings = lint({
      tools: connection.catalog.tools,
      resources: connection.catalog.resources,
      prompts: connection.catalog.prompts,
      testedTargets: lab.tests.list().length ? lab.tests.testedTargets() : undefined,
    });
    if (publish) {
      const anchored = await lab.lintDiagnostics.publish(findings, connection.config.name);
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
    const connection = lab.manager.get(serverId);
    if (!connection) {
      throw new Error(`Unknown server "${serverId}"`);
    }
    return scanSecurity({
      config: connection.config,
      tools: connection.catalog.tools,
      resources: connection.catalog.resources,
      prompts: connection.catalog.prompts,
      logs: lab.logs.query({ serverId }),
      history: lab.history.list({ serverId }),
      hasStoredCredential: !!(await lab.store.getAuthToken(serverId)),
      environmentTier: lab.activeEnvironment?.tier,
    });
  });

  // -- comparison ------------------------------------------------------------

  router.on('compare', async (params) => {
    const { leftId, rightId } = params as { leftId: string; rightId: string };
    return lab.compare(leftId, rightId);
  });

  // -- documentation ---------------------------------------------------------

  router.on('generateDocs', async (params) => {
    const { serverId } = params as { serverId: string };
    await vscode.commands.executeCommand('mcplab.generateDocs', { serverId });
    return true;
  });

  // -- catalog & search ------------------------------------------------------

  router.on('catalog', () => lab.catalog());

  router.on('search', (params) => {
    const { query } = params as { query: string };
    return lab.search(query);
  });

  router.on('openExternal', async (params) => {
    const { url } = params as { url: string };
    // Only ever opens a link the user put in their own server configuration.
    await vscode.env.openExternal(vscode.Uri.parse(url));
    return true;
  });

  // -- workflows -------------------------------------------------------------

  router.on('workflows', async () => {
    await lab.workflows.discover();
    return lab.workflows.list();
  });

  router.on('runWorkflow', async (params) => {
    const { workflowId, serverId } = params as { workflowId: string; serverId?: string };
    const workflow = lab.workflows.get(workflowId);
    if (!workflow) {
      throw new Error(`Unknown workflow "${workflowId}"`);
    }

    const problems = validateWorkflow(workflow);
    if (problems.length > 0) {
      throw new Error(`Workflow is not runnable:\n${problems.map((p) => `  • ${p}`).join('\n')}`);
    }

    // Every tool a workflow touches goes through the same risk gate as a manual call.
    const fallbackId = serverId ?? lab.manager.list().find((c) => c.status === 'connected')?.id;
    for (const step of workflow.steps) {
      if (step.kind !== 'tool' || !step.tool) {
        continue;
      }
      const target = lab.resolveServerByName(step.server ?? workflow.server) ?? fallbackId;
      if (target && !(await confirmIfRisky(lab, target, step.tool))) {
        throw new Error('Cancelled.');
      }
    }

    const runner = new WorkflowRunner(lab.execution, (name) =>
      lab.resolveServerByName(name) ?? fallbackId,
    );
    const subscription = runner.onDidCompleteStep((step) =>
      lab.panel.emit('workflow-step', step),
    );
    try {
      return await runner.run(workflow, { environment: lab.activeEnvironment?.name });
    } finally {
      subscription.dispose();
    }
  });

  // -- recording -------------------------------------------------------------

  router.on('recordingState', () => ({
    recording: lab.recorder.isRecording,
    entries: lab.recorder.recorded,
  }));

  router.on('startRecording', (params) => {
    const { serverId } = (params ?? {}) as { serverId?: string };
    lab.recorder.start(serverId ? { serverId } : undefined);
    return true;
  });

  router.on('stopRecording', () => {
    lab.recorder.stop();
    return lab.recorder.recorded;
  });

  router.on('dropRecorded', (params) => {
    const { id } = params as { id: string };
    lab.recorder.remove(id);
    return lab.recorder.recorded;
  });

  router.on('replayRecording', async () => {
    const replayed = await lab.recorder.replayAll();
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
    const workflow = lab.recorder.toWorkflow(name);
    const uri = await lab.workflows.save(workflow);
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
    const tests = lab.recorder.toTests();
    if (tests.length === 0) {
      throw new Error('Nothing was recorded.');
    }
    const uri = await lab.tests.append('recorded', tests);
    void vscode.window.showInformationMessage(
      `Saved ${tests.length} test(s) to ${vscode.workspace.asRelativePath(uri)}.`,
    );
    return true;
  });

  // -- placeholders fulfilled by later phases --------------------------------

  router.on('analyzeFailure', async (params) => {
    const { historyId } = params as { historyId: string };
    await vscode.commands.executeCommand('mcplab.analyzeFailure', historyId);
    return true;
  });

  router.on('saveAsTest', async (params) => {
    const { historyId } = params as { historyId: string };
    await vscode.commands.executeCommand('mcplab.saveAsTest', historyId);
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
  lab: McpLab,
  serverId: string,
  toolName: string,
): Promise<boolean> {
  const connection = lab.manager.get(serverId);
  const tool = connection?.catalog.tools.find((t) => t.name === toolName);
  if (!tool) {
    return true;
  }

  const environment = lab.activeEnvironment;
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
