import * as vscode from 'vscode';
import { classifyTool } from '../../core/environments';
import { localAnalysis } from './AiService';
import type { Workbench } from '../Workbench';

/**
 * `@mcp` in the Chat view.
 *
 * The participant's job is to put Workbench's own facts in front of the model -
 * the live catalog, the last failure, the logs - rather than to be a general
 * chatbot. Every answer is grounded in something Workbench observed.
 */
export function registerChatParticipant(
  context: vscode.ExtensionContext,
  workbench: Workbench,
): void {
  // vscode.chat is not present in every host, so its absence is not an error.
  if (typeof vscode.chat?.createChatParticipant !== 'function') {
    workbench.logs.log('debug', 'Chat API unavailable; @mcp participant not registered');
    return;
  }

  const participant = vscode.chat.createChatParticipant(
    'mcpilot.mcp',
    async (request, _chatContext, stream, token) => {
      switch (request.command) {
        case 'find':
          return handleFind(workbench, request, stream);
        case 'explain':
          return handleExplain(workbench, request, stream, token);
        case 'tests':
          return handleTests(workbench, request, stream);
        case 'why':
          return handleWhy(workbench, stream, token);
        case 'status':
          return handleStatus(workbench, stream);
        default:
          return handleDefault(workbench, request, stream, token);
      }
    },
  );

  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'mcp.svg');
  participant.followupProvider = {
    provideFollowups: () => [
      { prompt: 'Which servers are connected?', label: 'Status', command: 'status' },
      { prompt: 'Why did the last call fail?', label: 'Diagnose last failure', command: 'why' },
    ],
  };

  context.subscriptions.push(participant);
}

function handleStatus(workbench: Workbench, stream: vscode.ChatResponseStream): void {
  const entries = workbench.catalog();
  if (entries.length === 0) {
    stream.markdown('No MCP servers are configured yet.');
    return;
  }

  stream.markdown('| Server | Health | Tools | Resources | Prompts |\n|---|---|---|---|---|\n');
  for (const entry of entries) {
    stream.markdown(
      `| ${entry.name} | ${entry.health} | ${entry.counts.tools} | ${entry.counts.resources} | ${entry.counts.prompts} |\n`,
    );
  }

  const environment = workbench.activeEnvironment;
  if (environment) {
    stream.markdown(`\nActive environment: **${environment.name}** (${environment.tier}).\n`);
  }
}

function handleFind(
  workbench: Workbench,
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
): void {
  const query = request.prompt.trim();
  if (!query) {
    stream.markdown('Tell me what you are looking for, e.g. `@mcp /find deployment status`.');
    return;
  }

  const hits = workbench.search(query).slice(0, 12);
  if (hits.length === 0) {
    stream.markdown(
      `Nothing matching **${query}**. Only connected servers can be searched — a disconnected one has no catalog.`,
    );
    return;
  }

  stream.markdown(`Found ${hits.length} match(es) for **${query}**:\n\n`);
  for (const hit of hits) {
    const risk = hit.risk ? ` _(${hit.risk})_` : '';
    stream.markdown(`- \`${hit.name}\`${risk} on **${hit.serverName}** — ${hit.description ?? 'no description'}\n`);
  }
}

async function handleExplain(
  workbench: Workbench,
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  const name = request.prompt.trim();
  const found = findTool(workbench, name);
  if (!found) {
    stream.markdown(`I cannot find a tool called \`${name}\` on any connected server.`);
    return;
  }

  const { tool, serverName } = found;
  stream.markdown(`**\`${tool.name}\`** on **${serverName}** — classified \`${classifyTool(tool)}\`.\n\n`);
  stream.markdown(`${tool.description ?? '_No description._'}\n\n`);

  const properties = Object.entries(tool.inputSchema?.properties ?? {});
  if (properties.length > 0) {
    const required = new Set(tool.inputSchema?.required ?? []);
    stream.markdown('| Parameter | Type | Required |\n|---|---|---|\n');
    for (const [parameter, schema] of properties) {
      stream.markdown(
        `| \`${parameter}\` | ${String(schema.type ?? 'any')} | ${required.has(parameter) ? 'yes' : 'no'} |\n`,
      );
    }
  }

  const explanation = await workbench.ai.explain(
    [
      'In at most four sentences, explain when a developer would call this MCP tool and what to watch out for.',
      'Do not restate the parameter table.',
      JSON.stringify(tool, null, 2),
    ].join('\n\n'),
    token,
  );
  if (explanation) {
    stream.markdown(`\n${explanation}\n`);
  }
}

function handleTests(
  workbench: Workbench,
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
): void {
  const name = request.prompt.trim();
  const found = findTool(workbench, name);
  if (!found) {
    stream.markdown(`I cannot find a tool called \`${name}\`.`);
    return;
  }

  stream.markdown(`I can generate a schema-derived suite for \`${found.tool.name}\`.\n\n`);
  stream.button({
    command: 'mcpilot.generateTests',
    title: `Generate tests for ${found.tool.name}`,
    arguments: [found.serverId, found.tool.name],
  });
}

async function handleWhy(
  workbench: Workbench,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  const failure = workbench.history.list().find((entry) => entry.error || entry.toolError);
  if (!failure) {
    stream.markdown('Nothing has failed in this session.');
    return;
  }

  stream.markdown(
    `Most recent failure: \`${failure.name}\` on **${failure.serverName}**, ${new Date(failure.timestamp).toLocaleTimeString()}.\n\n`,
  );

  const connection = workbench.manager.get(failure.serverId);
  const tool = connection?.catalog.tools.find((entry) => entry.name === failure.name);
  stream.markdown(`${localAnalysis(failure, tool)}\n\n`);

  const deeper = await workbench.ai.analyzeFailure({
    entry: failure,
    tool,
    logs: workbench.logs
      .query({ serverId: failure.serverId })
      .slice(-20)
      .map((line) => `${line.level}: ${line.message}`),
    token,
  });
  if (deeper) {
    stream.markdown(`---\n\n${deeper}\n`);
  }

  stream.button({
    command: 'mcpilot.openItem',
    title: 'Open in MCPilot',
    arguments: [{ kind: 'tool', serverId: failure.serverId, tool: tool ?? { name: failure.name } }],
  });
}

async function handleDefault(
  workbench: Workbench,
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  const hits = workbench.search(request.prompt).slice(0, 8);

  if (hits.length > 0) {
    stream.markdown('Capabilities that look relevant:\n\n');
    for (const hit of hits) {
      stream.markdown(`- \`${hit.name}\` on **${hit.serverName}** — ${hit.description ?? ''}\n`);
    }
    stream.markdown('\n');
  }

  // The model sees only the catalog summary, never tool results or credentials.
  const context = workbench.catalog().map((entry) => ({
    server: entry.name,
    health: entry.health,
    tools: entry.counts.tools,
  }));

  const answer = await workbench.ai.explain(
    [
      'You are helping a developer work with MCP servers inside VS Code.',
      'Answer in at most six sentences. If the answer depends on a tool they have,',
      'name it exactly as listed.',
      '',
      `Configured servers: ${JSON.stringify(context)}`,
      `Matching capabilities: ${JSON.stringify(hits.map((hit) => ({ name: hit.name, server: hit.serverName, description: hit.description })))}`,
      '',
      `Question: ${request.prompt}`,
    ].join('\n'),
    token,
  );

  stream.markdown(
    answer ??
      'No language model is available in this window, so I can only answer from the catalog above. Try `/find`, `/explain`, `/tests`, `/why` or `/status`.',
  );
}

function findTool(
  workbench: Workbench,
  name: string,
): { tool: import('../../core/protocol').Tool; serverName: string; serverId: string } | undefined {
  for (const connection of workbench.manager.list()) {
    const tool = connection.catalog.tools.find(
      (entry) => entry.name.toLowerCase() === name.toLowerCase(),
    );
    if (tool) {
      return { tool, serverName: connection.config.name, serverId: connection.id };
    }
  }
  return undefined;
}
