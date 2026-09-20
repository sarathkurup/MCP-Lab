import * as vscode from 'vscode';
import type { LogEntry, LogStore } from '../../core/logging';
import type { TraceEntry, TraceStore } from '../../core/trace';

/**
 * Mirrors the core stores into VS Code output channels. Phase 5 replaces these
 * with rich webviews; the stores stay the source of truth either way.
 */
export class OutputChannels implements vscode.Disposable {
  private readonly logChannel: vscode.OutputChannel;
  private readonly traceChannel: vscode.OutputChannel;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(logs: LogStore, trace: TraceStore) {
    this.logChannel = vscode.window.createOutputChannel('MCPilot');
    this.traceChannel = vscode.window.createOutputChannel('MCPilot: Protocol', 'json');

    this.disposables.push(
      asDisposable(logs.onDidLog((entry) => this.logChannel.appendLine(formatLog(entry)))),
      asDisposable(trace.onDidTrace((entry) => this.traceChannel.appendLine(formatTrace(entry)))),
    );
  }

  showLogs(): void {
    this.logChannel.show(true);
  }

  showTrace(): void {
    this.traceChannel.show(true);
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.logChannel.dispose();
    this.traceChannel.dispose();
  }
}

function formatLog(entry: LogEntry): string {
  const time = new Date(entry.timestamp).toISOString().slice(11, 23);
  const scope = entry.serverId ? ` [${entry.serverId}]` : '';
  const origin = entry.source === 'workbench' ? '' : ` (${entry.source})`;
  return `${time} ${entry.level.toUpperCase().padEnd(5)}${scope}${origin} ${entry.message}`;
}

function formatTrace(entry: TraceEntry): string {
  const time = new Date(entry.timestamp).toISOString().slice(11, 23);
  const arrow = entry.direction === 'client->server' ? '-->' : '<--';
  const label = entry.method ?? `#${String(entry.id)}`;
  const took = entry.durationMs !== undefined ? ` (${entry.durationMs}ms)` : '';
  return [
    `${time} ${arrow} [${entry.serverId}] ${entry.kind} ${label}${took}`,
    JSON.stringify(entry.message, null, 2),
    '',
  ].join('\n');
}

function asDisposable(d: { dispose(): void }): vscode.Disposable {
  return new vscode.Disposable(() => d.dispose());
}
