import * as vscode from 'vscode';
import { RpcRouter, type RpcRequest } from '../../shared/rpc';

/**
 * Hosts the Workbench webview. Knows nothing about MCP: it owns the panel
 * lifecycle, the CSP-locked HTML shell, and the message pump. Every capability
 * arrives as an RPC method registered by the composition root.
 */
export class WorkbenchPanel implements vscode.Disposable {
  private static current?: WorkbenchPanel;

  readonly router = new RpcRouter();
  private panel?: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {}

  static register(context: vscode.ExtensionContext): WorkbenchPanel {
    if (!WorkbenchPanel.current) {
      WorkbenchPanel.current = new WorkbenchPanel(context);
    }
    return WorkbenchPanel.current;
  }

  get isOpen(): boolean {
    return !!this.panel;
  }

  reveal(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'mcpilot.panel',
      'MCPilot',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
          vscode.Uri.joinPath(this.context.extensionUri, 'media'),
        ],
      },
    );

    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'mcp.svg');
    panel.webview.html = this.buildHtml(panel.webview);

    panel.webview.onDidReceiveMessage(async (message: RpcRequest) => {
      if (message?.channel !== 'rpc') {
        return;
      }
      const response = await this.router.dispatch(message);
      void panel.webview.postMessage(response);
    });

    panel.onDidDispose(() => {
      this.panel = undefined;
    });

    this.panel = panel;
  }

  /** Pushes a one-way event to the view, if one is open. */
  emit(name: string, payload?: unknown): void {
    void this.panel?.webview.postMessage({ channel: 'event', name, payload });
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'workbench.css'),
    );

    // Scripts are nonce-locked and images are limited to the extension plus data
    // URIs, which servers use for image content blocks.
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link href="${styleUri}" rel="stylesheet" />
    <title>MCPilot</title>
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }

  dispose(): void {
    this.panel?.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
