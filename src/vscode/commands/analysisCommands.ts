import * as vscode from 'vscode';
import { lint, summarize } from '../../core/linter';
import type { TestCase } from '../../core/testing';
import type { TreeNode } from '../ui/ServersTreeProvider';
import type { Workbench } from '../Workbench';
import { openMarkdownDocument, resolveServerId } from './helpers';

/** Diagnostics, linting, test generation, failure analysis and environments. */

export async function diagnoseServer(
  workbench: Workbench,
  node?: TreeNode,
): Promise<void> {
  const serverId = await resolveServerId(workbench, node, 'Diagnose which server?');
  if (!serverId) {
    return;
  }
  workbench.focus({ serverId, view: 'doctor' });
}

export async function lintServer(workbench: Workbench, node?: TreeNode): Promise<void> {
  const serverId = await resolveServerId(workbench, node, 'Lint which server?');
  if (!serverId) {
    return;
  }
  const connection = workbench.manager.get(serverId);
  if (!connection || connection.status !== 'connected') {
    throw new Error('Connect the server before linting it.');
  }

  const findings = lint({
    tools: connection.catalog.tools,
    resources: connection.catalog.resources,
    prompts: connection.catalog.prompts,
    testedTargets: workbench.tests.list().length ? workbench.tests.testedTargets() : undefined,
  });
  const anchored = await workbench.lintDiagnostics.publish(findings, connection.config.name);
  const counts = summarize(findings);

  const action = await vscode.window.showInformationMessage(
    `MCP lint: ${counts.errors} error(s), ${counts.warnings} warning(s), ${counts.info} info.` +
      (anchored > 0
        ? ` ${anchored} anchored to source.`
        : ' No matching source locations; see the MCPilot panel.'),
    'Open MCPilot',
  );
  if (action === 'Open MCPilot') {
    workbench.focus({ serverId, view: 'doctor' });
  }
}

export async function generateTestsCommand(
  workbench: Workbench,
  serverIdArg?: string,
  toolNameArg?: string,
): Promise<void> {
  const serverId =
    serverIdArg ?? (await resolveServerId(workbench, undefined, 'Generate tests for which server?'));
  if (!serverId) {
    return;
  }
  const connection = workbench.manager.get(serverId);
  if (!connection || connection.status !== 'connected') {
    throw new Error('Connect the server before generating tests.');
  }

  let toolName = toolNameArg;
  if (!toolName) {
    const picked = await vscode.window.showQuickPick(
      connection.catalog.tools.map((tool) => ({
        label: tool.name,
        detail: tool.description,
        value: tool.name,
      })),
      { placeHolder: 'Generate tests for which tool?' },
    );
    toolName = picked?.value;
  }
  if (!toolName) {
    return;
  }

  const tool = connection.catalog.tools.find((t) => t.name === toolName);
  if (!tool) {
    throw new Error(`No tool "${toolName}"`);
  }

  const generated = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Generating tests for ${toolName}…`,
    },
    (_progress, token) => workbench.ai.generateTests(tool, connection.config.name, token),
  );

  // The user picks what to keep; nothing is written unasked.
  const picked = await vscode.window.showQuickPick(
    generated.tests.map((test) => ({
      label: test.name,
      description: test.expectError
        ? 'expects failure'
        : `${(test.assertions ?? []).length} assertion(s)`,
      detail: JSON.stringify(test.input),
      value: test,
      picked: true,
    })),
    {
      canPickMany: true,
      title: generated.usedModel
        ? 'Generated from the schema and a language model'
        : 'Generated from the schema (no language model available)',
      placeHolder: 'Choose the tests to save',
    },
  );
  if (!picked || picked.length === 0) {
    return;
  }

  const uri = await workbench.tests.append(
    toolName,
    picked.map((entry) => entry.value),
    connection.config.name,
  );
  const open = await vscode.window.showInformationMessage(
    `Saved ${picked.length} test(s) to ${vscode.workspace.asRelativePath(uri)}.`,
    'Open',
  );
  if (open === 'Open') {
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
  }
}

/** Turns a recorded invocation into a regression test. */
export async function saveAsTest(workbench: Workbench, historyId?: string): Promise<void> {
  if (!historyId) {
    return;
  }
  const entry = workbench.history.get(historyId);
  if (!entry) {
    throw new Error('That invocation is no longer in history.');
  }

  const name = await vscode.window.showInputBox({
    title: 'Save as MCP test',
    prompt: 'Test name',
    value: `${entry.name}: ${entry.error ? 'fails as expected' : 'succeeds'}`,
  });
  if (!name) {
    return;
  }

  const test: TestCase = {
    name,
    ...(entry.kind === 'tool'
      ? { tool: entry.name }
      : entry.kind === 'resource'
        ? { resource: entry.name }
        : { prompt: entry.name }),
    input: entry.input,
    ...(entry.error
      ? { expectError: { code: entry.error.code } }
      : { assertions: assertionsFor(entry.output) }),
  };

  const uri = await workbench.tests.append(entry.name, [test], entry.serverName);
  const open = await vscode.window.showInformationMessage(
    `Saved to ${vscode.workspace.asRelativePath(uri)}.`,
    'Open',
  );
  if (open === 'Open') {
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
  }
}

/**
 * Assertions that pin the shape of a response rather than its exact values, so
 * a recorded test does not break the first time a timestamp moves.
 */
export function assertionsFor(output: unknown): TestCase['assertions'] {
  const assertions: NonNullable<TestCase['assertions']> = [
    { path: '$.isError', notEquals: true },
  ];
  const result = output as { structuredContent?: unknown; content?: unknown[] } | undefined;

  if (result?.structuredContent && typeof result.structuredContent === 'object') {
    for (const [key, value] of Object.entries(result.structuredContent as Record<string, unknown>)) {
      assertions.push({
        path: `$.structuredContent.${key}`,
        type: Array.isArray(value)
          ? 'array'
          : value === null
            ? 'null'
            : (typeof value as 'string' | 'number' | 'boolean' | 'object'),
      });
    }
  } else if (Array.isArray(result?.content) && result.content.length > 0) {
    assertions.push({ path: '$.content[0].type', exists: true });
  }

  return assertions;
}

export async function analyzeFailure(workbench: Workbench, historyId?: string): Promise<void> {
  if (!historyId) {
    return;
  }
  const entry = workbench.history.get(historyId);
  if (!entry) {
    throw new Error('That invocation is no longer in history.');
  }

  const connection = workbench.manager.get(entry.serverId);
  const tool = connection?.catalog.tools.find((t) => t.name === entry.name);
  const logs = workbench.logs
    .query({ serverId: entry.serverId })
    .slice(-30)
    .map((line) => `${line.level}: ${line.message}`);

  const analysis = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Analyzing failure…' },
    (_progress, token) => workbench.ai.analyzeFailure({ entry, tool, logs, token }),
  );

  await openMarkdownDocument(
    [
      `# Failure analysis: ${entry.name}`,
      '',
      `Server: ${entry.serverName}`,
      `When: ${new Date(entry.timestamp).toLocaleString()}`,
      '',
      analysis,
      '',
      '## Request',
      '```json',
      JSON.stringify(entry.input, null, 2),
      '```',
      '',
      '## Response',
      '```json',
      JSON.stringify(entry.error ?? entry.output, null, 2),
      '```',
    ].join('\n'),
  );
}

export async function switchEnvironment(workbench: Workbench): Promise<void> {
  const environments = workbench.environments.list();
  const picked = await vscode.window.showQuickPick(
    environments.map((environment) => ({
      label: environment.name,
      description: environment.tier.toUpperCase(),
      detail: environment.id === workbench.activeEnvironment?.id ? 'Currently active' : undefined,
      value: environment,
    })),
    { placeHolder: 'Switch environment' },
  );
  if (!picked || picked.value.id === workbench.activeEnvironment?.id) {
    return;
  }

  if (picked.value.tier === 'prod') {
    const confirm = await vscode.window.showWarningMessage(
      `Switch to ${picked.value.name}?`,
      {
        modal: true,
        detail:
          'Write and destructive operations will require confirmation, but you will be pointing at production data.',
      },
      'Switch',
    );
    if (confirm !== 'Switch') {
      return;
    }
  }

  await workbench.setEnvironment(picked.value.id);
  void vscode.window.showInformationMessage(`MCP environment: ${picked.value.name}`);
}
