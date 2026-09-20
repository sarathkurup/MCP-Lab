import * as vscode from 'vscode';
import { ValidationFailure } from '../../core/execution';
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
 * Destructive tools get an explicit confirmation. Phase 12 extends this with
 * environment tiers; the hook lives here so there is exactly one gate.
 */
async function confirmIfRisky(
  workbench: Workbench,
  serverId: string,
  toolName: string,
): Promise<boolean> {
  const connection = workbench.manager.get(serverId);
  const tool = connection?.catalog.tools.find((t) => t.name === toolName);
  const destructive = tool?.annotations?.destructiveHint === true;
  if (!destructive) {
    return true;
  }

  const choice = await vscode.window.showWarningMessage(
    `"${toolName}" is annotated as destructive.`,
    {
      modal: true,
      detail: `Server: ${connection?.config.name}\nTarget: ${connection?.config.transport === 'http' ? connection.config.url : connection?.config.command}\n\nThis operation may change or delete data.`,
    },
    'Run anyway',
  );
  return choice === 'Run anyway';
}
