import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeNetworkFailure } from '../src/core/netErrors';
import {
  OAuthError,
  authorizationServerMetadataUrls,
  buildAuthorizationUrl,
  callbackError,
  checkAuthorizationServerCapabilities,
  codeChallengeFor,
  createNonce,
  createPkce,
  createState,
  exchangeAuthorizationCode,
  inspectAccessToken,
  loadAuthorizationServerMetadata,
  missingScopes,
  needsRefresh,
  parseAuthenticateChallenges,
  parseCallbackParams,
  parseWwwAuthenticate,
  refreshAccessToken,
  resourceCovers,
  sanitizeUrl,
  secretsEqual,
  validateIdToken,
  validateProtectedResourceMetadata,
  type AuthorizationServerMetadata,
} from '../src/core/oauth';
import { PendingAuthorizations, startLoopbackReceiver } from '../src/core/oauthCallback';
import { describeToolInput } from '../src/core/schema';
import { StreamableHttpTransport } from '../src/core/transport/StreamableHttpTransport';

const METADATA: AuthorizationServerMetadata = {
  issuer: 'https://login.example.test',
  authorizationEndpoint: 'https://login.example.test/authorize',
  tokenEndpoint: 'https://login.example.test/token',
};

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(claims)}.sig`;
}

function stubFetch(routes: Record<string, { status?: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes[url];
    if (!route) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json', ...(route.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

// ---------------------------------------------------------------------------

describe('oauth primitives: randomness and PKCE', () => {
  it('matches the RFC 7636 Appendix B test vector', () => {
    assert.equal(
      codeChallengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('generates a fresh verifier, state and nonce every time', () => {
    const verifiers = new Set(Array.from({ length: 40 }, () => createPkce().verifier));
    const states = new Set(Array.from({ length: 40 }, () => createState()));
    const nonces = new Set(Array.from({ length: 40 }, () => createNonce()));
    assert.equal(verifiers.size, 40);
    assert.equal(states.size, 40);
    assert.equal(nonces.size, 40);
    // 32 random bytes is 43 base64url characters.
    assert.equal(createState().length, 43);
  });

  it('compares secrets without short-circuiting on length', () => {
    assert.equal(secretsEqual('abc', 'abc'), true);
    assert.equal(secretsEqual('abc', 'abd'), false);
    assert.equal(secretsEqual('abc', 'abcd'), false);
    assert.equal(secretsEqual(undefined, 'abc'), false);
  });
});

describe('oauth primitives: WWW-Authenticate', () => {
  it('separates challenges that share a header', () => {
    const challenges = parseAuthenticateChallenges(
      'Basic realm="legacy", Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource", scope="mcp:read mcp:write"',
    );
    assert.deepEqual(challenges.map((challenge) => challenge.scheme), ['Basic', 'Bearer']);
    assert.equal(challenges[1].params.scope, 'mcp:read mcp:write');

    // The flat parser picks the Bearer challenge even when it is not first.
    const bearer = parseWwwAuthenticate('Basic realm="legacy", Bearer resource_metadata="https://x/y"');
    assert.equal(bearer.scheme, 'Bearer');
    assert.equal(bearer.resourceMetadata, 'https://x/y');
  });

  it('unescapes quoted values and keeps a token68', () => {
    const [negotiate, bearer] = parseAuthenticateChallenges('Negotiate abc123==, Bearer error_description="say \\"hi\\""');
    assert.equal(negotiate.token68, 'abc123==');
    assert.equal(bearer.params.error_description, 'say "hi"');
  });
});

describe('oauth primitives: authorization request and callback', () => {
  it('encodes every value through URLSearchParams', () => {
    const pkce = createPkce();
    const url = new URL(
      buildAuthorizationUrl({
        metadata: { ...METADATA, authorizationEndpoint: 'https://login.example.test/authorize?tenant=a b' },
        clientId: 'client id&x=1',
        redirectUri: 'http://127.0.0.1:5000/auth/callback?keep=me',
        pkce,
        state: 's',
        scope: 'openid api://app/Mcp.Read',
        nonce: 'n',
      }),
    );
    // The existing query survives, and injected-looking values stay values.
    assert.equal(url.searchParams.get('tenant'), 'a b');
    assert.equal(url.searchParams.get('client_id'), 'client id&x=1');
    assert.equal(url.searchParams.get('x'), null);
    assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:5000/auth/callback?keep=me');
    assert.equal(url.searchParams.get('scope'), 'openid api://app/Mcp.Read');
    assert.equal(url.searchParams.get('nonce'), 'n');
    assert.ok(!url.toString().includes(pkce.verifier));
  });

  it('reads error, error_description, error_uri and iss from a redirect', () => {
    assert.deepEqual(
      parseCallbackParams('?state=s&error=access_denied&error_description=nope&error_uri=https%3A%2F%2Fdocs&iss=https%3A%2F%2Flogin'),
      {
        code: undefined,
        state: 's',
        error: 'access_denied',
        errorDescription: 'nope',
        errorUri: 'https://docs',
        iss: 'https://login',
      },
    );
  });

  it('turns error redirects into actionable errors', () => {
    assert.equal(callbackError({ error: 'access_denied' }).code, 'login_cancelled');
    assert.equal(
      callbackError({ error: 'invalid_request', errorDescription: "AADSTS50011: The redirect URI 'x' does not match" }).code,
      'redirect_uri_mismatch',
    );
    assert.equal(callbackError({ error: 'invalid_scope' }).code, 'scope_not_granted');
    assert.match(
      callbackError({ error: 'invalid_request', errorDescription: "The 'resource' request parameter is not supported." }).hint ?? '',
      /resourceParameter/,
    );
  });
});

describe('oauth primitives: token endpoint', () => {
  const exchange = (body: unknown, status = 200) =>
    exchangeAuthorizationCode({
      metadata: METADATA,
      code: 'c',
      clientId: 'client',
      redirectUri: 'vscode://x/auth/callback',
      codeVerifier: 'v',
      fetchImpl: stubFetch({ [METADATA.tokenEndpoint]: { status, body } }).impl,
      now: () => 1_000,
    });

  it('accepts expires_in as a string and computes an absolute expiry', async () => {
    const tokens = await exchange({ access_token: 'a', token_type: 'bearer', expires_in: '60' });
    assert.equal(tokens.expiresAt, 1_000 + 60_000);
  });

  it('refuses a token that is not a bearer token', async () => {
    await assert.rejects(exchange({ access_token: 'a', token_type: 'mac' }), (err: OAuthError) => err.code === 'invalid_token_response');
  });

  it('classifies the error responses people actually hit', async () => {
    await assert.rejects(
      exchange({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' }, 400),
      (err: OAuthError) => err.code === 'redirect_uri_mismatch',
    );
    await assert.rejects(
      exchange({ error: 'invalid_client' }, 401),
      (err: OAuthError) => err.code === 'code_exchange_failed' && /CLIENT_ID/.test(err.hint ?? ''),
    );
  });

  it('rotates the refresh token and asks for the same scopes again', async () => {
    const stub = stubFetch({
      [METADATA.tokenEndpoint]: { body: { access_token: 'new', refresh_token: 'rotated', token_type: 'Bearer', expires_in: 60 } },
    });
    const tokens = await refreshAccessToken({
      metadata: METADATA,
      tokens: { accessToken: 'old', refreshToken: 'first', tokenType: 'Bearer' },
      clientId: 'client',
      scope: 'offline_access mcp:read',
      resource: 'https://mcp.example.test/mcp',
      fetchImpl: stub.impl,
    });
    assert.equal(tokens.refreshToken, 'rotated');
    const sent = new URLSearchParams(String(stub.calls[0].init?.body));
    assert.equal(sent.get('scope'), 'offline_access mcp:read');
    assert.equal(sent.get('resource'), 'https://mcp.example.test/mcp');
  });

  it('marks a rejected refresh as a refresh failure', async () => {
    await assert.rejects(
      refreshAccessToken({
        metadata: METADATA,
        tokens: { accessToken: 'a', refreshToken: 'r', tokenType: 'Bearer' },
        clientId: 'client',
        fetchImpl: stubFetch({ [METADATA.tokenEndpoint]: { status: 400, body: { error: 'invalid_grant' } } }).impl,
      }),
      (err: OAuthError) => err.code === 'refresh_failed',
    );
  });

  it('refreshes inside the skew window, not after the token died', () => {
    const now = 10_000_000;
    assert.equal(needsRefresh({ accessToken: 'a', tokenType: 'Bearer', expiresAt: now + 29_000 }, now), true);
    assert.equal(needsRefresh({ accessToken: 'a', tokenType: 'Bearer', expiresAt: now + 31_000 }, now), false);
  });
});

describe('oauth primitives: discovery validation', () => {
  it('tries the OIDC appended form for issuers with a path', () => {
    assert.deepEqual(authorizationServerMetadataUrls('https://login.example.test/tenant/v2.0'), [
      'https://login.example.test/.well-known/oauth-authorization-server/tenant/v2.0',
      'https://login.example.test/.well-known/openid-configuration/tenant/v2.0',
      'https://login.example.test/tenant/v2.0/.well-known/openid-configuration',
    ]);
  });

  it('skips a document that claims another issuer and falls back to the configured URL last', async () => {
    const issuer = 'https://login.example.test';
    const stub = stubFetch({
      [`${issuer}/.well-known/oauth-authorization-server`]: {
        body: { issuer: 'https://evil.example.test', authorization_endpoint: 'x', token_endpoint: 'y' },
      },
      'https://config.example.test/metadata.json': {
        body: { issuer, authorization_endpoint: `${issuer}/a`, token_endpoint: `${issuer}/t` },
      },
    });
    const metadata = await loadAuthorizationServerMetadata({
      issuer,
      discoveryUrl: 'https://config.example.test/metadata.json',
      fetchImpl: stub.impl,
    });
    assert.equal(metadata.issuer, issuer);
    assert.equal(stub.calls.at(-1)!.url, 'https://config.example.test/metadata.json');
  });

  it('accepts metadata for the resource or a parent path, never another origin', () => {
    assert.ok(resourceCovers('https://mcp.example.test/team/mcp', 'https://mcp.example.test/team/mcp/'));
    assert.ok(resourceCovers('https://mcp.example.test', 'https://mcp.example.test/team/mcp'));
    assert.ok(!resourceCovers('https://mcp.example.test/team', 'https://mcp.example.test/teams/mcp'));
    assert.ok(!resourceCovers('https://evil.example.test/team/mcp', 'https://mcp.example.test/team/mcp'));
  });

  it('rejects protected-resource metadata without a resource or for another resource', () => {
    assert.throws(
      () => validateProtectedResourceMetadata({ authorizationServers: ['https://a'] }, 'https://mcp.example.test/mcp'),
      (err: OAuthError) => err.code === 'invalid_resource_metadata',
    );
    assert.throws(
      () =>
        validateProtectedResourceMetadata(
          { resource: 'https://other.example.test/mcp', authorizationServers: ['https://a'] },
          'https://mcp.example.test/mcp',
        ),
      (err: OAuthError) => err.code === 'resource_mismatch',
    );
  });

  it('requires S256 when methods are advertised, and only warns when they are not', () => {
    const advertisedPlain = checkAuthorizationServerCapabilities({ ...METADATA, codeChallengeMethodsSupported: ['plain'] });
    assert.equal(advertisedPlain.errors[0]?.code, 'pkce_unsupported');

    const silent = checkAuthorizationServerCapabilities(METADATA);
    assert.equal(silent.errors.length, 0);
    assert.equal(silent.warnings.length, 1);

    const strict = checkAuthorizationServerCapabilities(METADATA, { strict: true });
    assert.equal(strict.errors[0]?.code, 'pkce_unsupported');

    const noCode = checkAuthorizationServerCapabilities({ ...METADATA, responseTypesSupported: ['token'], codeChallengeMethodsSupported: ['S256'] });
    assert.equal(noCode.errors[0]?.code, 'unsupported_grant');
  });
});

describe('oauth primitives: tokens', () => {
  const now = 1_700_000_000_000;
  const seconds = Math.floor(now / 1000);

  it('validates an ID token: issuer, audience, nonce and lifetime', () => {
    const good = jwt({ iss: METADATA.issuer, aud: 'client', nonce: 'n', exp: seconds + 600, sub: 'u' });
    assert.deepEqual(validateIdToken(good, { issuer: METADATA.issuer, clientId: 'client', nonce: 'n', now }).errors, []);

    const bad = jwt({ iss: 'https://other', aud: 'someone-else', nonce: 'x', exp: seconds - 3600 });
    const codes = validateIdToken(bad, { issuer: METADATA.issuer, clientId: 'client', nonce: 'n', now }).errors.map((e) => e.code);
    assert.deepEqual(codes.sort(), ['state_mismatch', 'token_expired', 'wrong_audience', 'wrong_issuer']);
  });

  it('refuses an access token minted for a different web resource', () => {
    const token = jwt({ iss: METADATA.issuer, aud: 'https://other.example.test/mcp', exp: seconds + 600 });
    const result = inspectAccessToken(token, { audiences: ['https://mcp.example.test/mcp'], now });
    assert.equal(result.errors[0]?.code, 'wrong_audience');
  });

  it('only warns about an application-id audience it cannot judge, unless pinned', () => {
    const token = jwt({ iss: METADATA.issuer, aud: 'api://11111111-2222', exp: seconds + 600 });
    const lenient = inspectAccessToken(token, { audiences: ['https://mcp.example.test/mcp'], now });
    assert.equal(lenient.errors.length, 0);
    assert.equal(lenient.warnings.length, 1);

    const pinnedRight = inspectAccessToken(token, { audiences: [], pinnedAudience: 'api://11111111-2222', now });
    assert.equal(pinnedRight.errors.length, 0);
    const pinnedWrong = inspectAccessToken(token, { audiences: [], pinnedAudience: 'api://expected', now });
    assert.equal(pinnedWrong.errors[0]?.code, 'wrong_audience');
  });

  it('treats an expired or not-yet-valid access token as an error', () => {
    const expired = inspectAccessToken(jwt({ exp: seconds - 3600 }), { audiences: [], now });
    assert.equal(expired.errors[0]?.code, 'token_expired');
    const early = inspectAccessToken(jwt({ nbf: seconds + 3600 }), { audiences: [], now });
    assert.equal(early.errors[0]?.code, 'token_expired');
  });

  it('accepts an opaque access token', () => {
    assert.deepEqual(inspectAccessToken('opaque-token', { audiences: [], now }).errors, []);
  });

  it('works out which requested scopes were not granted', () => {
    assert.deepEqual(missingScopes(['offline_access', 'api://app/Mcp.Read'], 'Mcp.Read'), [], 'short form counts');
    assert.deepEqual(missingScopes(['mcp:read', 'mcp:write'], 'mcp:read'), ['mcp:write']);
    assert.deepEqual(missingScopes(['mcp:read'], undefined), [], 'omitted scope means as requested');
  });
});

describe('oauth primitives: what may be shown', () => {
  it('strips credentials and query values from URLs', () => {
    assert.equal(
      sanitizeUrl('https://user:pass@mcp.example.test/mcp?key=s3cret&tenant=a#frag'),
      'https://mcp.example.test/mcp?key=***&tenant=***',
    );
  });

  it('explains certificate failures without suggesting turning checks off', () => {
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('unable to verify the first certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }),
    });
    const failure = describeNetworkFailure(err);
    assert.equal(failure.code, 'certificate_error');
    assert.match(failure.hint ?? '', /NODE_EXTRA_CA_CERTS/);
    assert.match(failure.hint ?? '', /never disabled/);
    assert.equal(describeNetworkFailure(Object.assign(new Error('x'), { cause: { code: 'ENOTFOUND' } })).code, 'network_error');
  });
});

describe('oauth callbacks: pending authorizations', () => {
  it('accepts a matching state exactly once', async () => {
    const registry = new PendingAuthorizations();
    const handle = registry.begin({ projectId: 'p', state: 'the-state', callbackPath: '/auth/callback', timeoutMs: 5_000 });
    assert.equal(registry.deliver('/auth/callback', '?state=the-state&code=c'), 'accepted');
    assert.equal((await handle.result).code, 'c');
    assert.equal(registry.deliver('/auth/callback', '?state=the-state&code=c'), 'duplicate');
  });

  it('fails the waiting sign-in on a mismatched or missing state', async () => {
    const registry = new PendingAuthorizations();
    const mismatched = registry.begin({ projectId: 'p', state: 'right', callbackPath: '/auth/callback', timeoutMs: 5_000 });
    assert.equal(registry.deliver('/auth/callback', '?state=wrong&code=c'), 'state-mismatch');
    await assert.rejects(mismatched.result, (err: OAuthError) => err.code === 'state_mismatch');

    const missing = registry.begin({ projectId: 'p', state: 'right', callbackPath: '/auth/callback', timeoutMs: 5_000 });
    assert.equal(registry.deliver('/auth/callback', '?code=c'), 'missing-state');
    await assert.rejects(missing.result, (err: OAuthError) => err.code === 'state_mismatch');
  });

  it('ignores callbacks on another path', () => {
    const registry = new PendingAuthorizations();
    registry.begin({ projectId: 'p', state: 's', callbackPath: '/auth/callback', timeoutMs: 5_000 });
    assert.equal(registry.deliver('/somewhere/else', '?state=s&code=c'), 'wrong-path');
    assert.ok(registry.hasPending('p'));
    registry.dispose();
  });

  it('rejects a response that arrives after the request expired', async () => {
    let clock = 0;
    const registry = new PendingAuthorizations(() => clock);
    const handle = registry.begin({ projectId: 'p', state: 's', callbackPath: '/auth/callback', timeoutMs: 60_000 });
    clock = 61_000;
    assert.equal(registry.deliver('/auth/callback', '?state=s&code=c'), 'expired');
    await assert.rejects(handle.result, (err: OAuthError) => err.code === 'timeout');
  });

  it('lets a newer sign-in for the same project supersede an older one', async () => {
    const registry = new PendingAuthorizations();
    const first = registry.begin({ projectId: 'p', state: 'one', callbackPath: '/auth/callback', timeoutMs: 5_000 });
    registry.begin({ projectId: 'p', state: 'two', callbackPath: '/auth/callback', timeoutMs: 5_000 });
    await assert.rejects(first.result, (err: OAuthError) => err.code === 'login_cancelled');
    registry.dispose();
  });
});

describe('oauth callbacks: loopback listener', () => {
  it('listens on 127.0.0.1 only, shows a page, then stops', async () => {
    const registry = new PendingAuthorizations();
    const handle = registry.begin({ projectId: 'p', state: 's', callbackPath: '/auth/callback', timeoutMs: 5_000 });
    const receiver = await startLoopbackReceiver({ registry });
    assert.match(receiver.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);

    const notFound = await fetch(`http://127.0.0.1:${receiver.port}/elsewhere?state=s&code=c`);
    assert.equal(notFound.status, 404);
    await notFound.body?.cancel();

    const page = await fetch(`${receiver.redirectUri}?state=s&code=c`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    const html = await page.text();
    assert.match(html, /Authentication is complete/);
    assert.ok(!html.includes('code=c'), 'the query must never be reflected into the page');
    assert.equal((await handle.result).code, 'c');

    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.rejects(() => fetch(receiver.redirectUri), 'still listening after the callback');
    await receiver.close();
  });

  it('answers a forged state with a rejection page and fails the sign-in', async () => {
    const registry = new PendingAuthorizations();
    const handle = registry.begin({ projectId: 'p', state: 'real', callbackPath: '/auth/callback', timeoutMs: 5_000 });
    const receiver = await startLoopbackReceiver({ registry });
    const page = await fetch(`${receiver.redirectUri}?state=forged&code=c`);
    assert.equal(page.status, 400);
    await page.body?.cancel();
    await assert.rejects(handle.result, (err: OAuthError) => err.code === 'state_mismatch');
    await receiver.close();
  });
});

describe('transport: credentials', () => {
  const ok = () =>
    new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  it('retries a 401 exactly once, with fresh headers', async () => {
    let token = 'old';
    const seen: string[] = [];
    let unauthorizedCalls = 0;
    const transport = new StreamableHttpTransport({
      url: 'https://mcp.example.test/mcp',
      authProvider: async () => ({ authorization: `Bearer ${token}` }),
      onUnauthorized: async (context) => {
        unauthorizedCalls++;
        assert.equal(context.authorization, 'Bearer old');
        token = 'new';
        return true;
      },
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        const auth = (init?.headers as Record<string, string>).authorization;
        seen.push(auth);
        return auth === 'Bearer new' ? ok() : new Response('{}', { status: 401 });
      }) as unknown as typeof fetch,
    });
    await transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    assert.deepEqual(seen, ['Bearer old', 'Bearer new']);
    assert.equal(unauthorizedCalls, 1);
  });

  it('stops after the retry is also rejected', async () => {
    let calls = 0;
    const transport = new StreamableHttpTransport({
      url: 'https://mcp.example.test/mcp',
      authProvider: async () => ({ authorization: 'Bearer t' }),
      onUnauthorized: async () => true,
      fetchImpl: (async () => {
        calls++;
        return new Response('{}', { status: 401 });
      }) as unknown as typeof fetch,
    });
    await assert.rejects(transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' }), /rejected the credential/);
    assert.equal(calls, 2);
  });

  it('never follows a redirect while carrying credentials', async () => {
    let redirectMode: string | undefined;
    const transport = new StreamableHttpTransport({
      url: 'https://mcp.example.test/mcp',
      authProvider: async () => ({ authorization: 'Bearer t' }),
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        redirectMode = init?.redirect;
        return new Response(null, { status: 307, headers: { location: 'https://attacker.example.test/collect' } });
      }) as unknown as typeof fetch,
    });
    await assert.rejects(
      transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      /redirected .* to https:\/\/attacker\.example\.test.*never forwarded/,
    );
    assert.equal(redirectMode, 'manual');
  });

  it('tells the credential provider where the request is going', async () => {
    const targets: string[] = [];
    const transport = new StreamableHttpTransport({
      url: 'https://mcp.example.test/mcp',
      authProvider: async (requestUrl) => {
        targets.push(requestUrl);
        return {};
      },
      fetchImpl: (async () => ok()) as unknown as typeof fetch,
    });
    await transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    assert.deepEqual(targets, ['https://mcp.example.test/mcp']);
  });
});

describe('tool input summaries', () => {
  it('lists required parameters first, with readable types', () => {
    const summary = describeToolInput({
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'How many' },
        query: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        mode: { enum: ['fast', 'slow'] },
      },
      required: ['query'],
    });
    assert.deepEqual(summary.problems, []);
    assert.deepEqual(
      summary.parameters.map((p) => `${p.name}:${p.type}:${p.required ? 'req' : 'opt'}`),
      ['query:string:req', 'limit:integer:opt', 'tags:array<string>:opt', 'mode:enum(fast|slow):opt'],
    );
    assert.equal(summary.parameters[1].description, 'How many');
  });

  it('handles a tool with no parameters', () => {
    assert.deepEqual(describeToolInput({ type: 'object' }), { parameters: [], problems: [] });
  });

  it('reports malformed schemas instead of throwing', () => {
    assert.deepEqual(describeToolInput(undefined).problems, ['The tool declares no inputSchema']);
    assert.deepEqual(describeToolInput('nope').problems, ['inputSchema is not a JSON object']);
    const messy = describeToolInput({
      type: 'string',
      properties: { a: 'not-a-schema', b: { type: 'number' } },
      required: ['a', 'ghost'],
    });
    assert.deepEqual(messy.parameters.map((p) => p.name), ['a', 'b']);
    assert.ok(messy.problems.some((p) => /type "string"/.test(p)));
    assert.ok(messy.problems.some((p) => /"ghost" is required but has no declared schema/.test(p)));
    assert.ok(messy.problems.some((p) => /"a" has no schema object/.test(p)));
    assert.deepEqual(describeToolInput({ properties: [], required: 'x' }).problems, [
      '"properties" is not an object',
      '"required" is not a list of parameter names',
    ]);
  });
});
