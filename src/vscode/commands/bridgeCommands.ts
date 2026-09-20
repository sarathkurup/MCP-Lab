import * as vscode from 'vscode';
import type { McpLab } from '../McpLab';

/**
 * Exposing McpLab to AI clients. The endpoint is loopback-only and
 * token-gated, and the token is only ever placed on the clipboard at the
 * user's explicit request.
 */

export async function startBridge(lab: McpLab): Promise<void> {
  const { url } = await lab.bridge.start();

  const action = await vscode.window.showInformationMessage(
    `MCP bridge listening on ${url}`,
    'Copy client config',
    'Permissions…',
  );

  if (action === 'Copy client config') {
    await copyBridgeConfig(lab);
  } else if (action === 'Permissions…') {
    await vscode.commands.executeCommand(
      'lab.action.openSettings',
      'mcplab.ai.permissions',
    );
  }
}

export async function stopBridge(lab: McpLab): Promise<void> {
  if (!lab.bridge.isRunning) {
    void vscode.window.showInformationMessage('The MCP bridge is not running.');
    return;
  }
  await lab.bridge.stop();
  lab.bridge.clearSessionApprovals();
  void vscode.window.showInformationMessage('MCP bridge stopped.');
}

export async function copyBridgeConfig(lab: McpLab): Promise<void> {
  const { url, token } = await lab.bridge.start();

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
      'mcplab': {
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
