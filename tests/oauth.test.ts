import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  buildAuthorizationUrl,
  createPkce,
  discoverAuthorizationServer,
  discoverProtectedResource,
  exchangeAuthorizationCode,
  needsRefresh,
  parseWwwAuthenticate,
  refreshAccessToken,
  registerClient,
  wellKnownUrls,
  type AuthorizationServerMetadata,
} from '../src/core/oauth';

/**
 * A fetch stub that answers from a routing table and records what it was asked.
 * Anything not in the table is a 404, which is what exercises the fallbacks -
 * discovery is mostly a sequence of guesses, and the guesses are the point.
 */
function stubFetch(routes: Record<string, { status?: number; body?: unknown; text?: string }>) {
  const calls: Array<{ url: string; method: string; body?: string; headers: Record<string, string> }> = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
      headers: (init?.headers as Record<string, string>) ?? {},
    });
    const route = routes[url];
    if (!route) {
      return new Response('not found', { status: 404 });
    }
    const status = route.status ?? 200;
    const payload = route.text ?? JSON.stringify(route.body ?? {});
    return new Response(payload, { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const METADATA: AuthorizationServerMetadata = {
  issuer: 'https://auth.example.com',
  authorizationEndpoint: 'https://auth.example.com/authorize',
  tokenEndpoint: 'https://auth.example.com/token',
};

describe('oauth: PKCE', () => {
  it('derives the challenge from the verifier with S256', () => {
    const pkce = createPkce();
    const expected = createHash('sha256')
      .update(pkce.verifier)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    assert.equal(pkce.challenge, expected);
    assert.equal(pkce.method, 'S256');
  });

  it('is base64url, so it survives a query string untouched', () => {
    const pkce = createPkce();
    assert.doesNotMatch(pkce.verifier + pkce.challenge, /[+/=]/);
    // RFC 7636 puts the verifier between 43 and 128 characters.
    assert.ok(pkce.verifier.length >= 43 && pkce.verifier.length <= 128);
  });

  it('never repeats', () => {
    const seen = new Set(Array.from({ length: 50 }, () => createPkce().verifier));
    assert.equal(seen.size, 50);
  });
});

describe('oauth: WWW-Authenticate', () => {
  it('finds the resource metadata url in a quoted challenge', () => {
    const challenge = parseWwwAuthenticate(
      'Bearer error="invalid_token", error_description="expired", resource_metadata="https://api.example.com/.well-known/oauth-protected-resource"',
    );
    assert.equal(challenge.scheme, 'Bearer');
    assert.equal(challenge.error, 'invalid_token');
    assert.equal(challenge.errorDescription, 'expired');
    assert.equal(
      challenge.resourceMetadata,
      'https://api.example.com/.well-known/oauth-protected-resource',
    );
  });

  it('accepts unquoted values, because servers are inconsistent', () => {
    const challenge = parseWwwAuthenticate('Bearer error=invalid_token, scope=mcp:read');
    assert.equal(challenge.error, 'invalid_token');
    assert.equal(challenge.scope, 'mcp:read');
  });

  it('survives a bare scheme', () => {
    assert.deepEqual(parseWwwAuthenticate('Bearer'), { scheme: 'Bearer' });
  });
});

describe('oauth: discovery', () => {
  it('puts .well-known between the host and the path', () => {
    assert.deepEqual(wellKnownUrls('https://api.example.com/mcp/v1', 'oauth-protected-resource'), [
      'https://api.example.com/.well-known/oauth-protected-resource/mcp/v1',
      'https://api.example.com/.well-known/oauth-protected-resource',
    ]);
  });

  it('does not emit the same candidate twice for a root url', () => {
    assert.deepEqual(wellKnownUrls('https://api.example.com/', 'x'), [
      'https://api.example.com/.well-known/x',
    ]);
  });

  it('falls back to the path-less well-known', () => {
    const { impl, calls } = stubFetch({
      'https://api.example.com/.well-known/oauth-protected-resource': {
        body: { resource: 'https://api.example.com/mcp', authorization_servers: ['https://auth.example.com'] },
      },
    });

    return discoverProtectedResource('https://api.example.com/mcp', { fetchImpl: impl }).then(
      (metadata) => {
        assert.deepEqual(metadata.authorizationServers, ['https://auth.example.com']);
        // The path-scoped candidate is tried first and 404s.
        assert.equal(calls[0].url, 'https://api.example.com/.well-known/oauth-protected-resource/mcp');
        assert.equal(calls.length, 2);
      },
    );
  });

  it('uses the url from the 401 when there is one, and asks nothing else', async () => {
    const { impl, calls } = stubFetch({
      'https://elsewhere.example.com/meta': {
        body: { authorization_servers: ['https://auth.example.com'] },
      },
    });
    const metadata = await discoverProtectedResource('https://api.example.com/mcp', {
      metadataUrl: 'https://elsewhere.example.com/meta',
      fetchImpl: impl,
    });
    assert.deepEqual(metadata.authorizationServers, ['https://auth.example.com']);
    assert.equal(calls.length, 1);
  });

  it('rejects metadata that names no authorization server', async () => {
    const { impl } = stubFetch({
      'https://api.example.com/.well-known/oauth-protected-resource': { body: { resource: 'x' } },
    });
    await assert.rejects(
      () => discoverProtectedResource('https://api.example.com', { fetchImpl: impl }),
      /No protected-resource metadata/,
    );
  });

  it('falls back to openid-configuration', async () => {
    const { impl } = stubFetch({
      'https://auth.example.com/.well-known/openid-configuration': {
        body: {
          issuer: 'https://auth.example.com',
          authorization_endpoint: 'https://auth.example.com/authorize',
          token_endpoint: 'https://auth.example.com/token',
          registration_endpoint: 'https://auth.example.com/register',
        },
      },
    });
    const metadata = await discoverAuthorizationServer('https://auth.example.com', {
      fetchImpl: impl,
    });
    assert.equal(metadata.tokenEndpoint, 'https://auth.example.com/token');
    assert.equal(metadata.registrationEndpoint, 'https://auth.example.com/register');
  });

  it('will not accept metadata missing a token endpoint', async () => {
    const { impl } = stubFetch({
      'https://auth.example.com/.well-known/oauth-authorization-server': {
        body: { issuer: 'x', authorization_endpoint: 'https://auth.example.com/authorize' },
      },
    });
    await assert.rejects(
      () => discoverAuthorizationServer('https://auth.example.com', { fetchImpl: impl }),
      /No authorization-server metadata/,
    );
  });
});

describe('oauth: registration', () => {
  it('registers as a public native client and asks for no secret', async () => {
    const { impl, calls } = stubFetch({
      'https://auth.example.com/register': { status: 201, body: { client_id: 'abc123' } },
    });
    const registration = await registerClient('https://auth.example.com/register', {
      clientName: 'MCP Lab',
      redirectUri: 'vscode://sarathkumar.mcplab/auth',
      fetchImpl: impl,
    });

    assert.equal(registration.clientId, 'abc123');
    assert.equal(registration.clientSecret, undefined);

    const sent = JSON.parse(calls[0].body!);
    assert.equal(sent.token_endpoint_auth_method, 'none');
    assert.equal(sent.application_type, 'native');
    assert.deepEqual(sent.redirect_uris, ['vscode://sarathkumar.mcplab/auth']);
    assert.ok(sent.grant_types.includes('refresh_token'));
  });

  it('reports a refusal with its status', async () => {
    const { impl } = stubFetch({
      'https://auth.example.com/register': { status: 403, text: 'nope' },
    });
    await assert.rejects(
      () =>
        registerClient('https://auth.example.com/register', {
          clientName: 'MCP Lab',
          redirectUri: 'vscode://x/auth',
          fetchImpl: impl,
        }),
      /HTTP 403/,
    );
  });
});

describe('oauth: authorization url', () => {
  it('carries PKCE, state and the resource indicator', () => {
    const pkce = createPkce();
    const url = new URL(
      buildAuthorizationUrl({
        metadata: METADATA,
        clientId: 'abc123',
        redirectUri: 'vscode://sarathkumar.mcplab/auth',
        pkce,
        state: 'xyz',
        scope: 'mcp:read mcp:write',
        resource: 'https://api.example.com/mcp',
      }),
    );

    assert.equal(url.origin + url.pathname, 'https://auth.example.com/authorize');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('code_challenge'), pkce.challenge);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('state'), 'xyz');
    assert.equal(url.searchParams.get('scope'), 'mcp:read mcp:write');
    // Without the resource indicator a multi-tenant issuer can mint a token for
    // a different MCP server entirely.
    assert.equal(url.searchParams.get('resource'), 'https://api.example.com/mcp');
    // The verifier must never appear in a URL that reaches the browser.
    assert.ok(!url.toString().includes(pkce.verifier));
  });

  it('leaves out scope and resource when there are none', () => {
    const url = new URL(
      buildAuthorizationUrl({
        metadata: METADATA,
        clientId: 'abc',
        redirectUri: 'vscode://x/auth',
        pkce: createPkce(),
        state: 's',
      }),
    );
    assert.equal(url.searchParams.has('scope'), false);
    assert.equal(url.searchParams.has('resource'), false);
  });
});

describe('oauth: token exchange', () => {
  it('sends the verifier and returns an expiry as an absolute time', async () => {
    const { impl, calls } = stubFetch({
      'https://auth.example.com/token': {
        body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600, token_type: 'Bearer' },
      },
    });

    const tokens = await exchangeAuthorizationCode({
      metadata: METADATA,
      code: 'the-code',
      clientId: 'abc',
      redirectUri: 'vscode://x/auth',
      codeVerifier: 'the-verifier',
      resource: 'https://api.example.com/mcp',
      fetchImpl: impl,
      now: () => 1_000_000,
    });

    assert.equal(tokens.accessToken, 'at');
    assert.equal(tokens.refreshToken, 'rt');
    assert.equal(tokens.expiresAt, 1_000_000 + 3_600_000);

    const sent = new URLSearchParams(calls[0].body!);
    assert.equal(sent.get('grant_type'), 'authorization_code');
    assert.equal(sent.get('code_verifier'), 'the-verifier');
    assert.equal(sent.get('resource'), 'https://api.example.com/mcp');
    assert.equal(calls[0].headers['content-type'], 'application/x-www-form-urlencoded');
  });

  it('surfaces the error description the server gives', async () => {
    const { impl } = stubFetch({
      'https://auth.example.com/token': {
        status: 400,
        body: { error: 'invalid_grant', error_description: 'code already used' },
      },
    });
    await assert.rejects(
      () =>
        exchangeAuthorizationCode({
          metadata: METADATA,
          code: 'c',
          clientId: 'abc',
          redirectUri: 'vscode://x/auth',
          codeVerifier: 'v',
          fetchImpl: impl,
        }),
      /code already used/,
    );
  });

  it('keeps the old refresh token when the refresh response omits one', async () => {
    const { impl } = stubFetch({
      'https://auth.example.com/token': {
        body: { access_token: 'new-at', expires_in: 60, token_type: 'Bearer' },
      },
    });

    const tokens = await refreshAccessToken({
      metadata: METADATA,
      tokens: { accessToken: 'old', refreshToken: 'keep-me', tokenType: 'Bearer', scope: 'mcp:read' },
      clientId: 'abc',
      fetchImpl: impl,
      now: () => 0,
    });

    assert.equal(tokens.accessToken, 'new-at');
    assert.equal(tokens.refreshToken, 'keep-me');
    assert.equal(tokens.scope, 'mcp:read');
  });

  it('refuses to refresh without a refresh token', async () => {
    await assert.rejects(
      () =>
        refreshAccessToken({
          metadata: METADATA,
          tokens: { accessToken: 'a', tokenType: 'Bearer' },
          clientId: 'abc',
        }),
      /sign in again/,
    );
  });
});

describe('oauth: expiry', () => {
  it('refreshes slightly early, so a call does not race the clock', () => {
    const now = 1_000_000;
    assert.equal(needsRefresh({ accessToken: 'a', tokenType: 'Bearer', expiresAt: now + 60_000 }, now), false);
    assert.equal(needsRefresh({ accessToken: 'a', tokenType: 'Bearer', expiresAt: now + 10_000 }, now), true);
    assert.equal(needsRefresh({ accessToken: 'a', tokenType: 'Bearer', expiresAt: now - 1 }, now), true);
  });

  it('treats a missing token as needing one, and an open-ended token as fine', () => {
    assert.equal(needsRefresh(undefined), true);
    assert.equal(needsRefresh({ accessToken: 'a', tokenType: 'Bearer' }), false);
  });
});
