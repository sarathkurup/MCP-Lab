import * as vscode from 'vscode';
import type { LintFinding } from '../../core/linter';

const SOURCE_GLOB = '**/*.{ts,js,mts,cts,tsx,py,cs,go,rb,java,json}';
const EXCLUDE = '{**/node_modules/**,**/dist/**,**/out/**,**/bin/**,**/obj/**,**/.git/**}';

/**
 * Publishes lint findings as editor diagnostics.
 *
 * MCP findings describe a *running server*, not a file, so each finding is
 * anchored by searching the workspace for the tool name as a string literal.
 * That is a heuristic: it lands on the definition for most servers and is
 * skipped silently when nothing matches, rather than guessing at a location.
 */
export class LintDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('mcp');

  async publish(findings: LintFinding[], serverName: string): Promise<number> {
    this.collection.clear();

    const byName = new Map<string, LintFinding[]>();
    for (const finding of findings) {
      if (finding.target.kind === 'server') {
        continue;
      }
      const list = byName.get(finding.target.name) ?? [];
      list.push(finding);
      byName.set(finding.target.name, list);
    }
    if (byName.size === 0) {
      return 0;
    }

    const files = await vscode.workspace.findFiles(SOURCE_GLOB, EXCLUDE, 2000);
    const perFile = new Map<string, vscode.Diagnostic[]>();
    let anchored = 0;

    for (const file of files) {
      let text: string;
      try {
        text = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
      } catch {
        continue;
      }

      for (const [name, group] of byName) {
        const index = findLiteral(text, name);
        if (index === -1) {
          continue;
        }
        const position = offsetToPosition(text, index);
        const range = new vscode.Range(
          position,
          position.translate(0, name.length + 2),
        );

        const diagnostics = perFile.get(file.toString()) ?? [];
        for (const finding of group) {
          const diagnostic = new vscode.Diagnostic(
            range,
            `${finding.rule}: ${finding.message}`,
            toSeverity(finding.severity),
          );
          diagnostic.source = `mcp (${serverName})`;
          diagnostic.code = finding.rule;
          diagnostics.push(diagnostic);
        }
        perFile.set(file.toString(), diagnostics);
        anchored += group.length;
        byName.delete(name);
      }

      if (byName.size === 0) {
        break;
      }
    }

    for (const [uri, diagnostics] of perFile) {
      this.collection.set(vscode.Uri.parse(uri), diagnostics);
    }
    return anchored;
  }

  clear(): void {
    this.collection.clear();
  }

  dispose(): void {
    this.collection.dispose();
  }
}

/** Finds `"name"` or `'name'` so a substring of a longer identifier is not matched. */
function findLiteral(text: string, name: string): number {
  for (const quote of ['"', "'", '`']) {
    const index = text.indexOf(`${quote}${name}${quote}`);
    if (index !== -1) {
      return index + 1;
    }
  }
  return -1;
}

function offsetToPosition(text: string, offset: number): vscode.Position {
  let line = 0;
  let lastBreak = -1;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lastBreak = i;
    }
  }
  return new vscode.Position(line, offset - lastBreak - 1);
}

function toSeverity(severity: LintFinding['severity']): vscode.DiagnosticSeverity {
  switch (severity) {
    case 'error':
      return vscode.DiagnosticSeverity.Error;
    case 'warning':
      return vscode.DiagnosticSeverity.Warning;
    default:
      return vscode.DiagnosticSeverity.Information;
  }
}
