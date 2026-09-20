import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AuthProvider, describeAuth } from '../src/core/auth';
import { compareServers } from '../src/core/compare';
import { generateDocs } from '../src/core/docs';
import type { Tool } from '../src/core/protocol';
import { scanSecurity } from '../src/core/security';

const TOOL: Tool = {
  name: 'updateEvent',
  description: 'Updates an event in the CMS.',
  inputSchema: {
    type: 'object',
    properties: {
      eventId: { type: 'string', description: 'Identifier' },
      title: { type: 'string', minLength: 3 },
      environment: { type: 'string', enum: ['DEV', 'QC'] },
    },
    required: ['eventId'],
  },
};

// ---------------------------------------------------------------------------

describe('auth', () => {
  it('builds a bearer header', async () => {
    const provider = new AuthProvider(
      { kind: 'bearer' },
      { resolveSecret: async () => 'abc123' },
    );
    assert.deepEqual(await provider.headers(), { authorization: 'Bearer abc123' });
  });

  it('builds a custom header and basic auth', async () => {
    const apiKey = new AuthProvider(
      { kind: 'header', headerName: 'X-API-Key' },
      { resolveSecret: async () => 'k' },
    );
    assert.deepEqual(await apiKey.headers(), { 'x-api-key': 'k' });

    const basic = new AuthProvider(
      { kind: 'basic', username: 'sam' },
      { resolveSecret: async () => 'pw' },
    );
    const headers = await basic.headers();
    assert.equal(headers.authorization, `Basic ${Buffer.from('sam:pw').toString('base64')}`);
  });

  it('sends nothing when no secret is stored', async () => {
    const provider = new AuthProvider(
      { kind: 'bearer' },
      { resolveSecret: async () => undefined },
    );
    assert.deepEqual(await provider.headers(), {});
  });

  it('mints, caches and refreshes an OAuth token', async () => {
    let calls = 0;
    let now = 1_000_000;

    const provider = new AuthProvider(
      {
        kind: 'oauth-client-credentials',
        tokenUrl: 'https://auth.example.com/token',
        clientId: 'client',
        scope: 'mcp.read',
      },
      {
        resolveSecret: async () => 'client-secret',
        now: () => now,
        fetchImpl: (async (_url: string, init?: RequestInit) => {
          calls++;
          const body = String(init?.body ?? '');
          assert.match(body, /grant_type=client_credentials/);
          assert.match(body, /scope=mcp.read/);
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({ access_token: `token-${calls}`, expires_in: 60 }),
          } as unknown as Response;
        }) as unknown as typeof fetch,
      },
    );

    assert.deepEqual(await provider.headers(), { authorization: 'Bearer token-1' });
    // Cached: the token endpoint is not hit again.
    assert.deepEqual(await provider.headers(), { authorization: 'Bearer token-1' });
    assert.equal(calls, 1);

    // Past the 30s early-refresh window, a new token is minted.
    now += 40_000;
    assert.deepEqual(await provider.headers(), { authorization: 'Bearer token-2' });
    assert.equal(calls, 2);
  });

  it('surfaces a failing token endpoint', async () => {
    const provider = new AuthProvider(
      { kind: 'oauth-client-credentials', tokenUrl: 'https://x/token', clientId: 'c' },
      {
        resolveSecret: async () => 's',
        fetchImpl: (async () =>
          ({ ok: false, status: 401, statusText: 'Unauthorized' }) as unknown as Response) as unknown as typeof fetch,
      },
    );
    await assert.rejects(() => provider.headers(), /401/);
  });

  it('describes a config without revealing the secret', () => {
    const described = describeAuth({ kind: 'header', headerName: 'X-API-Key' });
    assert.equal(described, 'Header X-API-Key');
    assert.equal(describeAuth(undefined), 'None');
  });
});

// ---------------------------------------------------------------------------

describe('security scan', () => {
  const base = {
    config: { id: 's', name: 'S', transport: 'http' as const, url: 'https://x/mcp' },
    tools: [] as Tool[],
    resources: [],
    prompts: [],
    logs: [],
    history: [],
    hasStoredCredential: true,
  };

  it('flags plain HTTP for a remote endpoint but not for loopback', () => {
    const remote = scanSecurity({
      ...base,
      config: { ...base.config, url: 'http://api.example.com/mcp' },
    });
    assert.ok(remote.findings.some((f) => f.id === 'SEC001' && f.severity === 'critical'));

    const local = scanSecurity({
      ...base,
      config: { ...base.config, url: 'http://localhost:3000/mcp' },
    });
    assert.ok(!local.findings.some((f) => f.id === 'SEC001'));
  });

  it('flags a credential pasted into a header setting', () => {
    const report = scanSecurity({
      ...base,
      config: {
        ...base.config,
        headers: { 'x-api-key': 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
      },
    });
    assert.ok(report.findings.some((f) => f.id === 'SEC002'));
  });

  it('does not flag a header that references a variable', () => {
    const report = scanSecurity({
      ...base,
      config: { ...base.config, headers: { 'x-api-key': '${env:API_KEY}' } },
    });
    assert.ok(!report.findings.some((f) => f.id === 'SEC002'));
  });

  it('flags a tool that takes or returns a credential', () => {
    const report = scanSecurity({
      ...base,
      tools: [
        {
          name: 'login',
          description: 'Signs in.',
          inputSchema: { type: 'object', properties: { password: { type: 'string' } } },
          outputSchema: { type: 'object', properties: { sessionToken: { type: 'string' } } },
        },
      ],
    });
    assert.ok(report.findings.some((f) => f.id === 'SEC010'));
    assert.ok(report.findings.some((f) => f.id === 'SEC011'));
  });

  it('flags a secret that appeared in logs', () => {
    const report = scanSecurity({
      ...base,
      logs: [
        {
          timestamp: Date.now(),
          level: 'info',
          source: 'stderr',
          message: 'using AKIAIOSFODNN7EXAMPLE to sign',
        },
      ],
    });
    const finding = report.findings.find((f) => f.id === 'SEC020');
    assert.ok(finding);
    assert.equal(finding!.severity, 'critical');
    assert.equal(finding!.evidence, 'logs');
  });

  it('flags a secret returned in a tool response', () => {
    const report = scanSecurity({
      ...base,
      history: [
        {
          id: '1',
          timestamp: Date.now(),
          serverId: 's',
          serverName: 'S',
          kind: 'tool',
          name: 'getConfig',
          input: {},
          output: { content: [{ type: 'text', text: 'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789' }] },
          durationMs: 1,
        },
      ],
    });
    assert.ok(report.findings.some((f) => f.id === 'SEC030'));
  });

  it('sorts by severity and counts each band', () => {
    const report = scanSecurity({
      ...base,
      config: { ...base.config, url: 'http://api.example.com/mcp' },
      tools: [
        {
          name: 'purgeAll',
          description: 'Removes everything.',
          inputSchema: { type: 'object', properties: { confirm: { type: 'boolean' } } },
        },
      ],
    });
    assert.equal(report.findings[0].severity, 'critical');
    assert.ok(report.counts.critical >= 1);
    assert.ok(report.counts.high >= 1, 'unannotated destructive tool');
  });

  it('is quiet on a clean server', () => {
    const report = scanSecurity({ ...base, tools: [TOOL] });
    assert.deepEqual(report.findings, []);
  });
});

// ---------------------------------------------------------------------------

describe('compare', () => {
  const left = {
    label: 'DEV',
    serverInfo: { name: 'cms', version: '2.4.1' },
    protocolVersion: '2025-06-18',
    tools: [TOOL, { name: 'deleteEvent', inputSchema: { type: 'object' as const } }],
    resources: [{ uri: 'file:///a', name: 'a' }],
    prompts: [{ name: 'p1' }],
  };

  it('detects removed tools as breaking', () => {
    const result = compareServers(left, { ...left, label: 'QC', tools: [TOOL] });
    const removed = result.tools.find((t) => t.name === 'deleteEvent')!;
    assert.equal(removed.kind, 'only-left');
    assert.ok(result.breakingCount >= 1);
  });

  it('detects a parameter that became required', () => {
    const stricter: Tool = {
      ...TOOL,
      inputSchema: { ...TOOL.inputSchema, required: ['eventId', 'title'] },
    };
    const result = compareServers(left, { ...left, label: 'QC', tools: [stricter, left.tools[1]] });
    const diff = result.tools.find((t) => t.name === 'updateEvent')!;
    const change = diff.differences.find((d) => d.path === 'input.title')!;
    assert.equal(change.breaking, true);
    assert.match(change.message, /optional to required/);
  });

  it('detects a removed enum value as breaking but an added one as safe', () => {
    const narrowed: Tool = {
      ...TOOL,
      inputSchema: {
        ...TOOL.inputSchema,
        properties: {
          ...TOOL.inputSchema.properties,
          environment: { type: 'string', enum: ['DEV'] },
        },
      },
    };
    const narrowedResult = compareServers(left, {
      ...left,
      label: 'QC',
      tools: [narrowed, left.tools[1]],
    });
    assert.ok(
      narrowedResult.tools
        .find((t) => t.name === 'updateEvent')!
        .differences.some((d) => d.breaking && /Enum/.test(d.message)),
    );

    const widened: Tool = {
      ...TOOL,
      inputSchema: {
        ...TOOL.inputSchema,
        properties: {
          ...TOOL.inputSchema.properties,
          environment: { type: 'string', enum: ['DEV', 'QC', 'PROD'] },
        },
      },
    };
    const widenedResult = compareServers(left, {
      ...left,
      label: 'QC',
      tools: [widened, left.tools[1]],
    });
    assert.ok(
      !widenedResult.tools
        .find((t) => t.name === 'updateEvent')!
        .differences.some((d) => d.breaking),
    );
  });

  it('treats a dropped destructiveHint as breaking', () => {
    const annotated: Tool = {
      name: 'deleteEvent',
      inputSchema: { type: 'object' },
      annotations: { destructiveHint: true },
    };
    const result = compareServers(
      { ...left, tools: [TOOL, annotated] },
      { ...left, label: 'QC', tools: [TOOL, { name: 'deleteEvent', inputSchema: { type: 'object' } }] },
    );
    const diff = result.tools.find((t) => t.name === 'deleteEvent')!;
    assert.ok(diff.differences.some((d) => d.path === 'annotations.destructiveHint' && d.breaking));
  });

  it('reports identical contracts as clean', () => {
    const result = compareServers(left, { ...left, label: 'QC' });
    assert.equal(result.tools.length, 0);
    assert.equal(result.breakingCount, 0);
  });
});

// ---------------------------------------------------------------------------

describe('docs', () => {
  const markdown = generateDocs({
    name: 'CMS MCP',
    serverInfo: { name: 'cms', version: '2.4.1' },
    protocolVersion: '2025-06-18',
    capabilities: { tools: {} },
    tools: [
      TOOL,
      {
        name: 'deleteEvent',
        description: 'Deletes an event.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        annotations: { destructiveHint: true },
      },
    ],
    resources: [{ uri: 'file:///templates', name: 'templates', mimeType: 'application/json' }],
    resourceTemplates: [],
    prompts: [
      { name: 'analyze', description: 'Analyzes.', arguments: [{ name: 'id', required: true }] },
    ],
  });

  it('documents every tool with a parameter table', () => {
    assert.match(markdown, /### `updateEvent`/);
    assert.match(markdown, /\| `eventId` \| string \| yes \|/);
    assert.match(markdown, /`DEV` \\\| `QC`/, 'enum values are listed');
  });

  it('warns about destructive tools', () => {
    assert.match(markdown, /⚠️ \*\*Destructive\.\*\*/);
  });

  it('includes a runnable example built from the schema', () => {
    assert.match(markdown, /"eventId": "test-eventId"/);
  });

  it('documents prompts and resources', () => {
    assert.match(markdown, /### `analyze`/);
    assert.match(markdown, /\| `id` \| yes \|/);
    assert.match(markdown, /### `file:\/\/\/templates`/);
  });
});
