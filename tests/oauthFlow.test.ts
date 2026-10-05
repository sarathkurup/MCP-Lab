import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { ConnectionManager } from '../src/core/ConnectionManager';
import { LogStore } from '../src/core/logging';
import { OAuthError } from '../src/core/oauth';
import {
  OAuthSessionManager,
  needsInteractiveSignIn,
  type OAuthSessionHost,
} from '../src/core/oauthSession';
import { projectToServerConfig, resolveProjects, type ResolvedProject } from '../src/core/projects';
import { TraceStore } from '../src/core/trace';
import {
  MemorySecrets,
  MemoryState,
  MockAuthServer,
  MockMcpServer,
  type MockAuthServerOptions,
  type MockMcpServerOptions,
} from './helpers/mockOAuth';

/**
 * The whole sign-in flow against real HTTP servers: a mock authorization
 * server and an OAuth-protected MCP server on 127.0.0.1. Nothing inside the
 * flow is stubbed - discovery, PKCE, the callback, the code exchange, refresh
 * and the MCP handshake all happen over sockets. The only simulation is the
 * user's browser, which follows the authorization URL like a person would.
 */

const CLIENT_ID = 'mcplab-test-client';
const TOOLS = [
  { name: 'search_docs', description: 'Search the docs.', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
  { name: 'get_page', description: 'Fetch a page.', inputSchema: { type: 'object', properties: { id: { type: 'integer' } } } },
  { name: 'no_description', inputSchema: { type: 'object' } },
  { name: 'delete_page', description: 'Delete a page.', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
  { name: 'stats', description: 'Usage numbers.', inputSchema: { type: 'object' } },
];

const running: Array<{ close(): Promise<void> }> = [];

async function authServer(options: Partial<MockAuthServerOptions> = {}): Promise<MockAuthServer> {
  const server = await new MockAuthServer({ clientId: CLIENT_ID, ...options }).start();
  running.push(server);
  return server;
}

async function mcpServer(auth: MockAuthServer, options: Partial<MockMcpServerOptions> = {}): Promise<MockMcpServer> {
  const server = await new MockMcpServer({ auth, tools: TOOLS, ...options }).start();
  running.push(server);
  return server;
}

after(async () => {
  await Promise.all(running.map((server) => server.close()));
});

function projectFor(
  mcp: MockMcpServer,
  auth: MockAuthServer,
  oauth: Record<string, unknown> = {},
  id = 'project-a',
): ResolvedProject {
  const { projects } = resolveProjects({
    projects: [
      {
        id,
        displayName: `Project ${id}`,
        mcpUrl: mcp.url,
        oauth: {
          clientId: CLIENT_ID,
          scopes: ['openid', 'offline_access', 'mcp:read'],
          authority: auth.issuer,
          ...oauth,
        },
      },
    ],
    env: {},
  });
  assert.equal(projects.length, 1);
  return projects[0];
}

interface Harness {
  manager: OAuthSessionManager;
  secrets: MemorySecrets;
  state: MemoryState;
  logs: string[];
  browserVisits: number;
}

/**
 * The editor half, minus the editor: in-memory storage, a log sink, and a
 * "browser" that follows the authorization URL to the identity provider and
 * then delivers the redirect where a real browser would - the editor's URI
 * handler, or the loopback listener.
 */
function harness(
  auth: MockAuthServer,
  options: {
    callback?: 'uri' | 'loopback';
    timeoutMs?: number;
    approve?: boolean;
    browser?: 'follow' | 'stall' | 'tamper-state';
  } = {},
): Harness {
  const secrets = new MemorySecrets();
  const state = new MemoryState();
  const logs: string[] = [];
  const result = { secrets, state, logs, browserVisits: 0 } as Harness;

  const host: OAuthSessionHost = {
    secrets,
    state,
    logger: {
      log: (level, projectId, message, detail) =>
        logs.push(`${level} ${projectId ?? '-'} ${message} ${JSON.stringify(detail ?? {})}`),
    },
    openBrowser: async (url) => {
      result.browserVisits++;
      if (options.browser === 'stall') return true;
      const visited = await auth.browse(url);
      if (!visited.location) return true; // the identity provider showed an error page
      const target = new URL(visited.location);
      if (options.browser === 'tamper-state') target.searchParams.set('state', 'forged-state-value');
      if (target.protocol === 'http:') {
        // A browser never throws into the extension; neither does this one.
        const response = await fetch(target).catch(() => undefined);
        await response?.body?.cancel().catch(() => undefined);
      } else {
        result.manager.deliverCallback(target.pathname, target.search);
      }
      return true;
    },
    editorRedirectUri:
      (options.callback ?? 'uri') === 'uri'
        ? async () => 'vscode://sarathkumar.mcplab/auth/callback'
        : undefined,
    approveAuthorizationServer: async () => options.approve ?? false,
    timeoutMs: options.timeoutMs ?? 10_000,
  };
  result.manager = new OAuthSessionManager(host);
  return result;
}

function connections(manager: OAuthSessionManager, projects: ResolvedProject[]) {
  const logs = new LogStore();
  const manager_ = new ConnectionManager({
    logs,
    trace: new TraceStore(500),
    requestTimeoutMs: () => 10_000,
    maxReconnectAttempts: () => 0,
    authProvider: async (config, requestUrl) => ({
      authorization: `Bearer ${await manager.getAccessToken(config.project!, requestUrl)}`,
    }),
    onUnauthorized: (config, context) => manager.handleUnauthorized(config.project!, context.authorization),
  });
  for (const project of projects) manager_.upsert(projectToServerConfig(project));
  return manager_;
}

async function expectOAuthError(promise: Promise<unknown>, code: string): Promise<OAuthError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof OAuthError, `expected an OAuthError, got ${String(err)}`);
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    return err;
  }
  assert.fail(`expected ${code}, but the call succeeded`);
}

function refreshCount(auth: MockAuthServer): number {
  return auth.tokenRequests.filter((params) => params.get('grant_type') === 'refresh_token').length;
}

// ---------------------------------------------------------------------------

describe('oauth flow: successful sign-in', () => {
  it('signs in through the editor URI handler, then lists every tool', async () => {
    const auth = await authServer();
    const mcp = await mcpServer(auth);
    const project = projectFor(mcp, auth);
    const h = harness(auth, { callback: 'uri' });

    const session = await h.manager.signIn(project);
    assert.equal(session.accountLabel, 'ada@example.test');
    assert.equal(session.issuer, auth.issuer);
    assert.ok(session.hasRefreshToken);

    // The authorization request the identity provider received.
    const request = auth.authorizeRequests[0];
    assert.equal(request.get('response_type'), 'code');
    assert.equal(request.get('client_id'), CLIENT_ID);
    assert.equal(request.get('code_challenge_method'), 'S256');
    assert.equal(request.get('code_challenge')?.length, 43);
    assert.equal(request.get('redirect_uri'), 'vscode://sarathkumar.mcplab/auth/callback');
    assert.equal(request.get('resource'), mcp.url);
    assert.equal(request.get('scope'), 'openid offline_access mcp:read');
    assert.ok(request.get('state') && request.get('state')!.length >= 43);
    assert.ok(request.get('nonce'), 'openid was requested, so a nonce must be sent');

    // No client secret for a public client.
    assert.equal(auth.tokenRequests[0].get('client_secret'), null);

    const manager = connections(h.manager, [project]);
    await manager.connect(project.id);
    const connection = manager.get(project.id)!;
    assert.equal(connection.status, 'connected');
    assert.deepEqual(
      connection.catalog.tools.map((tool) => tool.name),
      TOOLS.map((tool) => tool.name),
    );
    assert.ok(mcp.methods.includes('initialize'));
    assert.ok(mcp.methods.indexOf('notifications/initialized') < mcp.methods.indexOf('tools/list'));
    await manager.disposeAll();
  });

  it('signs in through a loopback listener on 127.0.0.1, which then stops', async () => {
    const auth = await authServer();
    const mcp = await mcpServer(auth);
    const project = projectFor(mcp, auth);
    const h = harness(auth, { callback: 'loopback' });

    await h.manager.signIn(project);
    const redirectUri = new URL(auth.authorizeRequests[0].get('redirect_uri')!);
    assert.equal(redirectUri.hostname, '127.0.0.1');
    assert.equal(redirectUri.pathname, '/auth/callback');
    assert.ok(Number(redirectUri.port) > 0, 'the OS chose a port');

    // The listener must be gone once the callback was handled.
    await assert.rejects(() => fetch(redirectUri), 'the loopback listener is still accepting connections');
  });

  it('finds metadata at the OIDC appended location enterprise identity providers use', async () => {
    const auth = await authServer({ issuerPath: '/tenant-1/v2.0', oidcSuffixOnly: true });
    const mcp = await mcpServer(auth);
    const h = harness(auth);
    const session = await h.manager.signIn(projectFor(mcp, auth));
    assert.equal(session.issuer, auth.issuer);
  });

  it('never writes a code, state, token or verifier to the log', async () => {
    const auth = await authServer();
    const mcp = await mcpServer(auth);
    const project = projectFor(mcp, auth);
    const h = harness(auth);
    await h.manager.signIn(project);

    const secrets = [
      ...auth.issuedSecrets,
      ...auth.authorizeRequests.flatMap((params) => [params.get('state')!, params.get('nonce')!]),
      ...auth.tokenRequests.flatMap((params) => [params.get('code_verifier') ?? '', params.get('code') ?? '']),
    ].filter((value) => value && value.length > 8);
    assert.ok(secrets.length >= 6);

    const transcript = h.logs.join('\n');
    for (const secret of secrets) {
      assert.ok(!transcript.includes(secret), 'a secret value reached the log');
    }
    // What should be there is there.
    for (const event of ['Protected-resource discovery started', 'Redirect URI resolved', 'Browser authentication opened', 'Callback received', 'OAuth state validated', 'Token exchange completed']) {
      assert.ok(transcript.includes(event), `missing log event: ${event}`);
    }
  });
});

describe('oauth flow: the user and the identity provider say no', () => {
  it('reports a sign-in the user cancelled at the identity provider', async () => {
    const auth = await authServer({ mode: 'deny' });
    const mcp = await mcpServer(auth);
    const h = harness(auth);
    await expectOAuthError(h.manager.signIn(projectFor(mcp, auth)), 'login_cancelled');
    assert.equal(h.manager.session('project-a'), undefined);
    assert.equal(auth.tokenRequests.length, 0);
  });

  it('stops waiting when the user cancels from the editor', async () => {
    const auth = await authServer();
    const mcp = await mcpServer(auth);
    const h = harness(auth, { browser: 'stall' });
    const controller = new AbortController();
    const pending = h.manager.signIn(projectFor(mcp, auth), { signal: controller.signal });
    setTimeout(() => controller.abort(), 150);
    await expectOAuthError(pending, 'login_cancelled');
  });

  it('rejects a callback whose state was tampered with, before any code exchange', async () => {
    const auth = await authServer();
    const mcp = await mcpServer(auth);
    const h = harness(auth, { browser: 'tamper-state' });
    await expectOAuthError(h.manager.signIn(projectFor(mcp, auth)), 'state_mismatch');
    assert.equal(auth.tokenRequests.length, 0, 'a code from a mismatched callback must never be exchanged');
  });

  it('times out with a redirect-URI hint when the identity provider rejects the redirect URI', async () => {
    const auth = await authServer({ mode: 'reject-redirect' });
    const mcp = await mcpServer(auth);
    const h = harness(auth, { timeoutMs: 400 });
    const error = await expectOAuthError(h.manager.signIn(projectFor(mcp, auth)), 'timeout');
    assert.match(error.hint ?? '', /redirect URI/);
  });

  it('reports a redirect_uri mismatch raised at the token endpoint', async () => {
    const auth = await authServer({ tokenRedirectMismatch: true });
    const mcp = await mcpServer(auth);
    const h = harness(auth);
    await expectOAuthError(h.manager.signIn(projectFor(mcp, auth)), 'redirect_uri_mismatch');
  });

  it('refuses a session when a required scope was not granted', async () => {
    const auth = await authServer({ grantScopes: (requested) => requested.filter((scope) => scope !== 'mcp:read') });
    const mcp = await mcpServer(auth);
    const h = harness(auth);
    const error = await expectOAuthError(h.manager.signIn(projectFor(mcp, auth)), 'scope_not_granted');
    assert.match(error.message, /mcp:read/);
    assert.equal(h.manager.session('project-a'), undefined);
    assert.equal(h.secrets.values.size, 0, 'nothing may be stored for a refused session');
  });

  it('explains how to proceed when the identity provider will not take a resource parameter', async () => {
    const auth = await authServer({ mode: 'resource-unsupported' });
    const mcp = await mcpServer(auth, { acceptedAudiences: ['api://mock-api'] });
    const h = harness(auth);
    const error = await expectOAuthError(h.manager.signIn(projectFor(mcp, auth)), 'oauth_error');
    assert.match(error.hint ?? '', /resourceParameter/);

    // ...and that following the hint works.
    const session = await h.manager.signIn(projectFor(mcp, auth, { resourceParameter: 'never' }));
    assert.equal(session.accountLabel, 'ada@example.test');
    assert.equal(auth.authorizeRequests.at(-1)!.has('resource'), false);
  });
});

describe('oauth flow: refresh', () => {
  it('refreshes an expiring token and stores the rotated refresh token', async () => {
    const auth = await authServer({ accessTokenTtlSeconds: 1 });
    const mcp = await mcpServer(auth);
    const project = projectFor(mcp, auth);
    const h = harness(auth);
    await h.manager.signIn(project);
    const firstRefresh = [...h.secrets.values.entries()].find(([key]) => key.endsWith('.refreshToken'))![1];

    // One second of lifetime is inside the 30 s skew, so this refreshes first.
    const token = await h.manager.getAccessToken(project, mcp.url);
    assert.equal(refreshCount(auth), 1);
    const secondRefresh = [...h.secrets.values.entries()].find(([key]) => key.endsWith('.refreshToken'))![1];
    assert.notEqual(secondRefresh, firstRefresh, 'the rotated refresh token must replace the old one');
    assert.ok(auth.accessTokens.has(token));
    assert.equal(auth.tokenRequests.at(-1)!.get('resource'), mcp.url, 'refresh asks for the same resource');
  });

  it('makes one token request for many simultaneous callers', async () => {
    const auth = await authServer({ accessTokenTtlSeconds: 1 });
    const mcp = await mcpServer(auth);
    const project = projectFor(mcp, auth);
    const h = harness(auth);
    await h.manager.signIn(project);

    const tokens = await Promise.all(Array.from({ length: 6 }, () => h.manager.getAccessToken(project, mcp.url)));
    assert.equal(new Set(tokens).size, 1);
    assert.equal(refreshCount(auth), 1);
  });

  it('clears the session and asks for sign-in when the refresh token is rejected', async () => {
    const auth = await authServer({ accessTokenTtlSeconds: 1, rejectRefresh: true });
    const mcp = await mcpServer(auth);
    const project = projectFor(mcp, auth);
    const h = harness(auth);
    await h.manager.signIn(project);

    await expectOAuthError(h.manager.getAccessToken(project, mcp.url), 'sign_in_required');
    assert.equal(h.manager.session(project.id), undefined);
    assert.equal(
      [...h.secrets.values.keys()].filter((key) => key.startsWith(`mcplab.auth.${project.id}.`)).length,
      0,
    );
  });
});

describe('oauth flow: talking to the MCP server', () => {
  it('fails an unauthenticated connection with a sign-in requirement, sending no token', async () => {
    const auth = await authServer();
    const mcp = await mcpServer(auth);
    const project = projectFor(mcp, auth);
    const h = harness(auth);
    const manager = connections(h.manager, [project]);

    await assert.rejects(manager.connect(project.id), (err: unknown) => needsInteractiveSignIn(err));
    assert.equal(mcp.authorizations.length, 0);
    assert.equal(manager.get(project.id)!.status, 'error');
    await manager.disposeAll();
  });

  it('answers a 401 on a live connection with one refresh and one retry', async () => {
    const auth = await authServer();
    const mcp = await mcpServer(auth);
    const project = projectFor(mcp, auth);
    const h = harness(auth);
    await h.manager.signIn(project);
    const manager = connections(h.manager, [project]);
    await manager.connect(project.id);

    auth.revokeAll(); // the server will now reject the token it is holding
    const before = mcp.unauthorizedCount;
    const catalog = await manager.get(project.id)!.refreshCatalog();
    assert.equal(catalog.tools.length, TOOLS.length);
    assert.equal(refreshCount(auth), 1);
    assert.equal(mcp.unauthorizedCount - before, 1);
    await manager.disposeAll();
  });

  it('gives up after a single retry when the server keeps rejecting fresh tokens', async () => {
    const auth = await authServer();
    const mcp = await mcpServer(auth);
    const project = projectFor(mcp, auth);
    const h = harness(auth);
    await h.manager.signIn(project);
    const manager = connections(h.manager, [project]);
    await manager.connect(project.id);

    (mcp as unknown as { authorized: () => boolean }).authorized = () => false;
    const before = mcp.unauthorizedCount;
    const catalog = await manager.get(project.id)!.refreshCatalog();
    assert.match(catalog.errors?.tools ?? '', /401/);
    assert.equal(refreshCount(auth), 1, 'exactly one refresh, no loop');
    assert.equal(mcp.unauthorizedCount - before, 2, 'the original request and one retry');
    await manager.disposeAll();
  });

  it('keeps a connection whose tools/list failed distinct from one with no tools', async () => {
    const auth = await authServer();
    const mcp = await mcpServer(auth, { failToolsList: true });
    const project = projectFor(mcp, auth);
    const h = harness(auth);
    await h.manager.signIn(project);
    const manager = connections(h.manager, [project]);
    await manager.connect(project.id);

    const connection = manager.get(project.id)!;
    assert.equal(connection.status, 'connected', 'initialization itself succeeded');
    assert.equal(connection.catalog.tools.length, 0);
    assert.match(connection.catalog.errors?.tools ?? '', /tools\/list failed: tool registry unavailable/);
    await manager.disposeAll();
  });

  it('follows tools/list cursors across every page', async () => {
    const auth = await authServer();
    const mcp = await mcpServer(auth, { pageSize: 2 });
    const project = projectFor(mcp, auth);
    const h = harness(auth);
    await h.manager.signIn(project);
    const manager = connections(h.manager, [project]);
    await manager.connect(project.id);

    assert.equal(manager.get(project.id)!.catalog.tools.length, TOOLS.length);
    assert.equal(mcp.methods.filter((method) => method === 'tools/list').length, 3);
    await manager.disposeAll();
  });
});

describe('oauth flow: projects stay apart', () => {
  it('keeps two projects signed in at once with their own tokens and servers', async () => {
    const auth = await authServer();
    const mcpA = await mcpServer(auth);
    const mcpB = await mcpServer(auth);
    const projectA = projectFor(mcpA, auth, {}, 'project-a');
    const projectB = projectFor(mcpB, auth, {}, 'project-b');
    const h = harness(auth);
    await h.manager.signIn(projectA);
    await h.manager.signIn(projectB);

    const manager = connections(h.manager, [projectA, projectB]);
    await manager.connect(projectA.id);
    // Switching projects: the first transport is disposed before the second connects.
    await manager.disconnect(projectA.id);
    await manager.connect(projectB.id);

    const tokenA = await h.manager.getAccessToken(projectA, mcpA.url);
    const tokenB = await h.manager.getAccessToken(projectB, mcpB.url);
    assert.notEqual(tokenA, tokenB);
    assert.ok(mcpA.authorizations.every((header) => header === `Bearer ${tokenA}`));
    assert.ok(mcpB.authorizations.every((header) => header === `Bearer ${tokenB}`));

    await h.manager.signOut(projectA);
    assert.equal(h.manager.session(projectA.id), undefined);
    assert.ok(h.manager.session(projectB.id), 'signing out of one project leaves the other alone');
    await manager.disposeAll();
  });

  it("refuses to send one project's token to another project's server", async () => {
    const auth = await authServer();
    const mcpA = await mcpServer(auth);
    const mcpB = await mcpServer(auth);
    const projectA = projectFor(mcpA, auth, {}, 'project-a');
    const h = harness(auth);
    await h.manager.signIn(projectA);

    await expectOAuthError(h.manager.getAccessToken(projectA, mcpB.url), 'token_host_mismatch');

    // And the other server would have refused it anyway: wrong audience.
    const tokenA = await h.manager.getAccessToken(projectA, mcpA.url);
    const response = await fetch(mcpB.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    await response.body?.cancel();
    assert.equal(response.status, 401);
  });

  it('discards a stored session when the project is re-pointed at another client', async () => {
    const auth = await authServer();
    const mcp = await mcpServer(auth);
    const h = harness(auth);
    await h.manager.signIn(projectFor(mcp, auth));

    const changed = projectFor(mcp, auth, { clientId: 'a-different-client' });
    await expectOAuthError(h.manager.getAccessToken(changed, mcp.url), 'sign_in_required');
    assert.equal([...h.secrets.values.keys()].filter((key) => key.endsWith('.accessToken')).length, 0);
  });

  it('tears down a live transport when its project configuration changes', async () => {
    const auth = await authServer();
    const mcp = await mcpServer(auth);
    const project = projectFor(mcp, auth);
    const h = harness(auth);
    await h.manager.signIn(project);
    const manager = connections(h.manager, [project]);
    await manager.connect(project.id);
    assert.equal(manager.get(project.id)!.status, 'connected');

    manager.upsert(projectToServerConfig(projectFor(mcp, auth, { scopes: ['mcp:read', 'mcp:write'] })));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(manager.get(project.id)!.status, 'disconnected');
    await manager.disposeAll();
  });

  it('removes every stored secret on sign-out', async () => {
    const auth = await authServer();
    const mcp = await mcpServer(auth);
    const project = projectFor(mcp, auth);
    const h = harness(auth);
    const changes: string[] = [];
    h.manager.onDidChangeSessions((change) => changes.push(`${change.kind}:${change.projectId}`));

    await h.manager.signIn(project);
    assert.equal([...h.secrets.values.keys()].filter((key) => key.startsWith('mcplab.auth.project-a.')).length, 3);

    await h.manager.signOut(project);
    assert.equal([...h.secrets.values.keys()].filter((key) => key.startsWith('mcplab.auth.project-a.')).length, 0);
    assert.equal(h.manager.session(project.id), undefined);
    assert.deepEqual(changes, ['added:project-a', 'removed:project-a']);
  });
});

describe('oauth flow: discovery that must not be followed', () => {
  it('refuses protected-resource metadata on another host', async () => {
    const auth = await authServer();
    const elsewhere = await mcpServer(auth);
    const mcp = await mcpServer(auth, {
      challenge: 'foreign-metadata',
      foreignMetadataUrl: `${elsewhere.origin}/.well-known/oauth-protected-resource/mcp`,
    });
    const h = harness(auth);
    await expectOAuthError(h.manager.signIn(projectFor(mcp, auth)), 'untrusted_host');
    assert.equal(auth.authorizeRequests.length, 0);
    assert.equal(h.browserVisits, 0);
  });

  it('refuses an authorization server other than the configured authority', async () => {
    const auth = await authServer();
    const impostor = await authServer();
    const mcp = await mcpServer(auth, { authorizationServers: [impostor.issuer] });
    const h = harness(auth);
    await expectOAuthError(h.manager.signIn(projectFor(mcp, auth)), 'authorization_server_mismatch');
    assert.equal(h.browserVisits, 0);
  });

  it('asks before trusting an authorization server nobody configured', async () => {
    const auth = await authServer();
    const mcp = await mcpServer(auth);
    const unpinned = projectFor(mcp, auth, { authority: undefined });

    await expectOAuthError(harness(auth, { approve: false }).manager.signIn(unpinned), 'untrusted_host');

    const approving = harness(auth, { approve: true });
    const session = await approving.manager.signIn(unpinned);
    assert.equal(session.issuer, auth.issuer);
  });

  it('rejects metadata that describes a different resource', async () => {
    const auth = await authServer();
    const mcp = await mcpServer(auth, { declaredResource: 'http://127.0.0.1:9/somewhere-else' });
    const h = harness(auth);
    await expectOAuthError(h.manager.signIn(projectFor(mcp, auth)), 'resource_mismatch');
  });

  it('catches an authorization-server mix-up through the iss parameter', async () => {
    const auth = await authServer({ mode: 'wrong-iss' });
    const mcp = await mcpServer(auth);
    const h = harness(auth);
    await expectOAuthError(h.manager.signIn(projectFor(mcp, auth)), 'issuer_mismatch');
    assert.equal(auth.tokenRequests.length, 0);
  });

  it('skips a metadata document that claims a different issuer', async () => {
    const auth = await authServer({ declaredIssuer: 'https://login.attacker.example' });
    const mcp = await mcpServer(auth);
    const h = harness(auth);
    await expectOAuthError(h.manager.signIn(projectFor(mcp, auth)), 'issuer_mismatch');
  });

  it('falls back to the configured authority when the server publishes no metadata', async () => {
    const auth = await authServer();
    const mcp = await mcpServer(auth, {
      challenge: 'no-header',
      servePrm: false,
      acceptedAudiences: ['api://mock-api'],
    });
    const h = harness(auth);
    const project = projectFor(mcp, auth);

    const discovery = await h.manager.discover(project);
    assert.equal(discovery.issuer, auth.issuer);
    assert.equal(discovery.protectedResource, undefined);
    assert.equal(discovery.sendResource, false, 'nothing asked for a resource parameter');
    assert.ok(discovery.warnings.some((warning) => /WWW-Authenticate/.test(warning)));

    const session = await h.manager.signIn(project);
    assert.equal(session.accountLabel, 'ada@example.test');
  });

  it('explains a 401 with no challenge when nothing else is configured', async () => {
    const auth = await authServer();
    const mcp = await mcpServer(auth, { challenge: 'no-header', servePrm: false });
    const h = harness(auth);
    const error = await expectOAuthError(
      h.manager.signIn(projectFor(mcp, auth, { authority: undefined })),
      'missing_www_authenticate',
    );
    assert.match(error.hint ?? '', /MCP_OAUTH_AUTHORITY/);
  });
});

describe('oauth flow: configuration', () => {
  it('refuses to start without the required settings, naming what to set', async () => {
    const auth = await authServer();
    const mcp = await mcpServer(auth);
    const { projects } = resolveProjects({ env: { MCP_URL: mcp.url } });
    const h = harness(auth);
    const error = await expectOAuthError(h.manager.signIn(projects[0]), 'missing_configuration');
    assert.match(error.message, /MCP_OAUTH_CLIENT_ID/);
    assert.match(error.message, /MCP_OAUTH_SCOPES/);
    assert.equal(h.browserVisits, 0);
  });
});

before(() => {
  // Discovery's probe and the loopback listener both use real sockets; make
  // sure nothing here is accidentally pointed at a proxy.
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
});
