import * as vscode from 'vscode';
import type { Workbench } from '../Workbench';

/**
 * Exposing Workbench to AI clients. The endpoint is loopback-only and
 * token-gated, and the token is only ever placed on the clipboard at the
 * user's explicit request.
 */

export async function startBridge(workbench: Workbench): Promise<void> {
  const { url } = await workbench.bridge.start();

  const action = await vscode.window.showInformationMessage(
    `MCP bridge listening on ${url}`,
    'Copy client config',
    'Permissions…',
  );

  if (action === 'Copy client config') {
    await copyBridgeConfig(workbench);
  } else if (action === 'Permissions…') {
    await vscode.commands.executeCommand(
      'workbench.action.openSettings',
      'mcpWorkbench.ai.permissions',
    );
  }
}

export async function stopBridge(workbench: Workbench): Promise<void> {
  if (!workbench.bridge.isRunning) {
    void vscode.window.showInformationMessage('The MCP bridge is not running.');
    return;
  }
  await workbench.bridge.stop();
  workbench.bridge.clearSessionApprovals();
  void vscode.window.showInformationMessage('MCP bridge stopped.');
}

export async function copyBridgeConfig(workbench: Workbench): Promise<void> {
  const { url, token } = await workbench.bridge.start();

  const confirmed = await vscode.window.showWarningMessage(
    'Copy the bridge configuration to the clipboard?',
    {
      modal: true,
      detail:
        'It contains an access token that lets any client reach every MCP server you have configured. Paste it only into a client you trust.',
    },
    'Copy',
  );
  if (confirmed !== 'Copy') {
    return;
  }

  const config = {
    mcpServers: {
      'mcp-workbench': {
        type: 'http',
        url,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  };

  await vscode.env.clipboard.writeText(JSON.stringify(config, null, 2));
  void vscode.window.showInformationMessage(
    'Bridge configuration copied. It is valid while VS Code is running and the bridge is started.',
  );
}
