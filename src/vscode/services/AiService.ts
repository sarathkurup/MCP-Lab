import * as vscode from 'vscode';
import type { HistoryEntry } from '../../core/history';
import type { Tool } from '../../core/protocol';
import type { TestCase } from '../../core/testing';
import { generateTests } from '../../core/testgen';

/**
 * Optional language-model layer, built on VS Code's own `vscode.lm` API so it
 * uses whatever model the user already has, with no key handling here.
 *
 * Every feature degrades: test generation falls back to the deterministic
 * schema generator, and failure analysis falls back to a structured local
 * explanation. Nothing in Workbench requires a model to be present.
 */
export class AiService {
  async isAvailable(): Promise<boolean> {
    try {
      const models = await vscode.lm.selectChatModels();
      return models.length > 0;
    } catch {
      return false;
    }
  }

  private async pickModel(): Promise<vscode.LanguageModelChat | undefined> {
    try {
      const models = await vscode.lm.selectChatModels();
      return models[0];
    } catch {
      return undefined;
    }
  }

  /**
   * Schema-derived cases always come back; model-authored cases are added on
   * top when one is available, and are discarded if they do not parse.
   */
  async generateTests(
    tool: Tool,
    serverName: string,
    token?: vscode.CancellationToken,
  ): Promise<{ tests: TestCase[]; usedModel: boolean }> {
    const deterministic = generateTests(tool);
    const model = await this.pickModel();
    if (!model) {
      return { tests: deterministic, usedModel: false };
    }

    const prompt = [
      'You are generating declarative tests for an MCP (Model Context Protocol) tool.',
      'Return ONLY a JSON array, no prose and no code fence.',
      'Each element must be: {"name": string, "tool": string, "input": object,',
      '  "assertions"?: [{"path": "$.structuredContent.x", "equals"|"contains"|"type"|"exists": ...}],',
      '  "expectError"?: true}',
      'The path syntax is JSONPath-lite against the CallToolResult: $.content[0].text,',
      '$.structuredContent.<field>, $.isError.',
      '',
      `Server: ${serverName}`,
      `Tool definition:`,
      JSON.stringify(tool, null, 2),
      '',
      'These schema-derived cases already exist; do NOT repeat them:',
      deterministic.map((t) => `- ${t.name}`).join('\n'),
      '',
      'Add up to 6 cases a schema cannot express: realistic business values,',
      'semantic edge cases, and combinations that are individually valid but',
      'contradictory together. Prefer assertions that would still pass if the',
      'server changed unrelated fields.',
    ].join('\n');

    try {
      const response = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)],
        {},
        token ?? new vscode.CancellationTokenSource().token,
      );

      let text = '';
      for await (const fragment of response.text) {
        text += fragment;
      }

      const parsed = extractJsonArray(text);
      const extra = parsed
        .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
        .map((entry) => ({
          name: String(entry.name ?? `${tool.name}: generated`),
          tool: tool.name,
          input: entry.input ?? {},
          assertions: Array.isArray(entry.assertions) ? entry.assertions : [],
          expectError: entry.expectError === true ? true : undefined,
        })) as TestCase[];

      return { tests: [...deterministic, ...extra], usedModel: extra.length > 0 };
    } catch {
      // A model failure is never fatal: the deterministic suite still stands.
      return { tests: deterministic, usedModel: false };
    }
  }

  /**
   * Explains a failed invocation using everything Workbench already captured:
   * the tool definition, the request, the response and the surrounding logs.
   */
  async analyzeFailure(context: {
    entry: HistoryEntry;
    tool?: Tool;
    logs: string[];
    token?: vscode.CancellationToken;
  }): Promise<string> {
    const local = localAnalysis(context.entry, context.tool);
    const model = await this.pickModel();
    if (!model) {
      return local;
    }

    const prompt = [
      'An MCP tool call failed. Explain the most likely cause in at most six lines,',
      'then give a corrected request as a JSON object under a "Suggested request" heading.',
      'Be concrete. If the schema explains the failure, say which field and why.',
      '',
      context.tool ? `Tool definition:\n${JSON.stringify(context.tool, null, 2)}` : '',
      `Request:\n${JSON.stringify(context.entry.input, null, 2)}`,
      context.entry.error
        ? `Error:\n${JSON.stringify(context.entry.error, null, 2)}`
        : `Response:\n${JSON.stringify(context.entry.output, null, 2)}`,
      context.logs.length ? `Recent server logs:\n${context.logs.slice(-20).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    try {
      const response = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)],
        {},
        context.token ?? new vscode.CancellationTokenSource().token,
      );
      let text = '';
      for await (const fragment of response.text) {
        text += fragment;
      }
      return text.trim() || local;
    } catch (err) {
      return `${local}\n\n_(A language model was available but the request failed: ${
        err instanceof Error ? err.message : String(err)
      })_`;
    }
  }

  async explain(prompt: string, token?: vscode.CancellationToken): Promise<string | undefined> {
    const model = await this.pickModel();
    if (!model) {
      return undefined;
    }
    try {
      const response = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)],
        {},
        token ?? new vscode.CancellationTokenSource().token,
      );
      let text = '';
      for await (const fragment of response.text) {
        text += fragment;
      }
      return text.trim();
    } catch {
      return undefined;
    }
  }
}

/**
 * Deterministic diagnosis. Covers the failure modes that show up most often
 * and needs no model, which also makes it testable.
 */
export function localAnalysis(entry: HistoryEntry, tool?: Tool): string {
  const lines: string[] = [];
  const error = entry.error;

  if (!error) {
    lines.push('The call completed but the server flagged the result as an error.');
    return lines.join('\n');
  }

  switch (error.code) {
    case -32602:
      lines.push('**Invalid parameters.** The server rejected the request payload.');
      break;
    case -32601:
      lines.push('**Method not found.** The tool or method does not exist on this server.');
      break;
    case -32001:
      lines.push('**Timed out.** The server accepted the request but never replied.');
      break;
    case -32002:
      lines.push('**Connection closed** while the request was in flight.');
      break;
    default:
      lines.push(`**Server error** (code ${error.code ?? 'unknown'}).`);
  }

  lines.push('', `> ${error.message}`);

  if (tool) {
    const required = tool.inputSchema?.required ?? [];
    const sent = Object.keys((entry.input ?? {}) as Record<string, unknown>);
    const missing = required.filter((name) => !sent.includes(name));
    if (missing.length) {
      lines.push('', `Missing required field(s): \`${missing.join('`, `')}\``);
    }

    const properties = tool.inputSchema?.properties ?? {};
    const unknown = sent.filter((name) => !(name in properties));
    if (unknown.length && Object.keys(properties).length > 0) {
      lines.push('', `Field(s) not in the schema: \`${unknown.join('`, `')}\``);
    }

    for (const [name, property] of Object.entries(properties)) {
      const value = (entry.input as Record<string, unknown> | undefined)?.[name];
      if (value === undefined || !property.format || typeof value !== 'string') {
        continue;
      }
      lines.push('', `\`${name}\` is declared as format \`${property.format}\`; sent \`${value}\`.`);
    }
  }

  return lines.join('\n');
}

function extractJsonArray(text: string): unknown[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) {
    return [];
  }
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
