import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_PROJECT_ID,
  adhocProject,
  bindingKey,
  blockingIssues,
  describeIssues,
  findWorkspaceOverrides,
  projectToServerConfig,
  resolveProjects,
  substituteEnv,
} from '../src/core/projects';

const ENV = {
  MCP_URL: 'https://mcp.example.test/team/mcp',
  MCP_OAUTH_CLIENT_ID: 'env-client',
  MCP_OAUTH_SCOPES: 'offline_access api://team/Mcp.Read',
  MCP_OAUTH_AUTHORITY: 'https://login.example.test/tenant/v2.0',
};

describe('projects: environment and settings', () => {
  it('builds the default project from MCP_* environment variables alone', () => {
    const { projects, issues } = resolveProjects({ env: ENV });
    assert.deepEqual(issues, []);
    const project = projects[0];
    assert.equal(project.id, DEFAULT_PROJECT_ID);
    assert.equal(project.mcpUrl, ENV.MCP_URL);
    assert.equal(project.oauth.clientId, 'env-client');
    assert.deepEqual(project.oauth.scopes, ['offline_access', 'api://team/Mcp.Read']);
    assert.equal(project.sources.mcpUrl, 'environment');
    assert.equal(project.sources['oauth.clientId'], 'environment');
  });

  it('lets settings override the environment, value by value', () => {
    const { projects } = resolveProjects({
      env: ENV,
      settings: { serverUrl: 'https://mcp.example.test/other/mcp', oauth: { scopes: ['mcp.read'] } },
    });
    const project = projects[0];
    assert.equal(project.mcpUrl, 'https://mcp.example.test/other/mcp');
    assert.equal(project.sources.mcpUrl, 'settings');
    assert.deepEqual(project.oauth.scopes, ['mcp.read']);
    // Untouched values still come from the environment.
    assert.equal(project.oauth.clientId, 'env-client');
    assert.equal(project.sources['oauth.clientId'], 'environment');
  });

  it('defaults the resource to the MCP URL, and records that it did', () => {
    const { projects } = resolveProjects({ env: ENV });
    assert.equal(projects[0].oauth.resource, ENV.MCP_URL);
    assert.equal(projects[0].oauth.resourceConfigured, false);

    const configured = resolveProjects({ env: { ...ENV, MCP_OAUTH_RESOURCE: 'api://team' } }).projects[0];
    assert.equal(configured.oauth.resource, 'api://team');
    assert.equal(configured.oauth.resourceConfigured, true);
  });

  it('describes no project at all when nothing is configured', () => {
    assert.deepEqual(resolveProjects({ env: {} }).projects, []);
    // Behavioural switches alone do not conjure a project.
    assert.deepEqual(resolveProjects({ env: {}, settings: { oauth: { callbackMode: 'loopback' } } }).projects, []);
  });

  it('uses safe defaults for the behavioural switches', () => {
    const project = resolveProjects({ env: ENV }).projects[0];
    assert.equal(project.oauth.callbackMode, 'auto');
    assert.equal(project.oauth.resourceParameter, 'auto');
    assert.equal(project.oauth.strict, false);
    assert.deepEqual(project.oauth.trustedHosts, []);
  });
});

describe('projects: client secrets', () => {
  it('never resolves a secret into the project, only where it lives', () => {
    const project = resolveProjects({ env: { ...ENV, MCP_OAUTH_CLIENT_SECRET: 's3cr3t-value' } }).projects[0];
    assert.deepEqual(project.oauth.clientSecretSource, { kind: 'environment', variable: 'MCP_OAUTH_CLIENT_SECRET' });
    assert.ok(!JSON.stringify(project).includes('s3cr3t-value'));
    assert.ok(!JSON.stringify(projectToServerConfig(project)).includes('s3cr3t-value'));
  });

  it('prefers secure storage over the environment', () => {
    const project = resolveProjects({
      env: { ...ENV, MCP_OAUTH_CLIENT_SECRET: 'x' },
      secureClientSecrets: new Set([DEFAULT_PROJECT_ID]),
    }).projects[0];
    assert.deepEqual(project.oauth.clientSecretSource, { kind: 'secure-storage' });
  });

  it('refuses a client secret written into settings, without repeating it', () => {
    const { projects, issues } = resolveProjects({
      env: {},
      projects: [
        {
          id: 'team',
          mcpUrl: 'https://mcp.example.test/mcp',
          oauth: { clientId: 'c', scopes: ['s'], clientSecret: 'literal-secret-in-settings' },
        },
      ],
    });
    assert.equal(projects[0].oauth.clientSecretSource, undefined);
    const issue = issues.find((candidate) => candidate.key === 'oauth.clientSecret');
    assert.ok(issue);
    assert.equal(issue.severity, 'error');
    assert.ok(!issue.message.includes('literal-secret-in-settings'));
    assert.ok(!describeIssues(issues).includes('literal-secret-in-settings'));
  });

  it('accepts a secret named by reference', () => {
    const project = resolveProjects({
      env: { TEAM_SECRET: 'value' },
      projects: [
        {
          id: 'team',
          mcpUrl: 'https://mcp.example.test/mcp',
          oauth: { clientId: 'c', scopes: ['s'], clientSecret: '${env:TEAM_SECRET}' },
        },
      ],
    }).projects[0];
    assert.deepEqual(project.oauth.clientSecretSource, { kind: 'environment', variable: 'TEAM_SECRET' });
  });
});

describe('projects: several at once', () => {
  const projects = [
    {
      id: 'project-a',
      displayName: 'Project A',
      mcpUrl: '${env:MCP_PROJECT_A_URL}',
      oauth: {
        clientId: '${env:MCP_PROJECT_A_OAUTH_CLIENT_ID}',
        scopes: ['offline_access', 'api://a/Mcp.Read'],
        authority: 'https://login.a.example.test/tenant-a/v2.0',
      },
    },
    {
      id: 'project-b',
      mcpUrl: 'https://mcp.b.example.test/mcp',
      oauth: { clientId: 'client-b', scopes: 'mcp:read mcp:write', authority: 'https://idp.b.example.test' },
    },
  ];

  it('resolves each project from its own configuration and environment references', () => {
    const { projects: resolved, issues } = resolveProjects({
      projects,
      env: { MCP_PROJECT_A_URL: 'https://mcp.a.example.test/mcp', MCP_PROJECT_A_OAUTH_CLIENT_ID: 'client-a' },
    });
    assert.deepEqual(issues, []);
    assert.deepEqual(resolved.map((project) => project.id), ['project-a', 'project-b']);
    assert.equal(resolved[0].mcpUrl, 'https://mcp.a.example.test/mcp');
    assert.equal(resolved[0].oauth.clientId, 'client-a');
    assert.equal(resolved[0].environmentReferences.mcpUrl, 'MCP_PROJECT_A_URL');
    assert.deepEqual(resolved[1].oauth.scopes, ['mcp:read', 'mcp:write']);
  });

  it('does not let one project inherit another identity provider or client', () => {
    const { projects: resolved } = resolveProjects({
      projects,
      env: { MCP_PROJECT_A_URL: 'https://mcp.a.example.test/mcp', MCP_PROJECT_A_OAUTH_CLIENT_ID: 'client-a', ...ENV },
    });
    const b = resolved.find((project) => project.id === 'project-b')!;
    assert.equal(b.oauth.clientId, 'client-b');
    assert.equal(b.oauth.authority, 'https://idp.b.example.test');
    // The environment's default project still exists, separately.
    assert.ok(resolved.find((project) => project.id === DEFAULT_PROJECT_ID));
  });

  it('names an unset environment variable instead of guessing a value', () => {
    const { projects: resolved, issues } = resolveProjects({ projects, env: {} });
    const a = resolved.find((project) => project.id === 'project-a')!;
    assert.equal(a.mcpUrl, '');
    const messages = blockingIssues(a).map((issue) => issue.message).join(' | ');
    assert.match(messages, /\$\{env:MCP_PROJECT_A_URL\}, which is not set/);
    assert.match(messages, /\$\{env:MCP_PROJECT_A_OAUTH_CLIENT_ID\}, which is not set/);
    assert.ok(issues.length >= 2);
  });

  it('rejects a duplicate project id', () => {
    const { projects: resolved, issues } = resolveProjects({
      projects: [projects[1], { ...projects[1], displayName: 'again' }],
      env: {},
    });
    assert.equal(resolved.length, 1);
    assert.ok(issues.some((issue) => /more than once/.test(issue.message)));
  });

  it('turns each project into a server definition with no secret in it', () => {
    const resolved = resolveProjects({ projects: [projects[1]], env: {} }).projects[0];
    const server = projectToServerConfig(resolved);
    assert.equal(server.id, 'project-b');
    assert.equal(server.transport, 'http');
    assert.equal(server.url, 'https://mcp.b.example.test/mcp');
    assert.equal(server.auth?.kind, 'oauth');
    assert.equal(server.source, 'project');
  });
});

describe('projects: validation', () => {
  const base = { clientId: 'c', scopes: ['s'] };
  const one = (mcpUrl: string, oauth: Record<string, unknown> = base) =>
    resolveProjects({ projects: [{ id: 'p', mcpUrl, oauth }], env: {} }).projects[0];

  it('names every missing required value and how to set it', () => {
    const { projects } = resolveProjects({ env: { MCP_OAUTH_AUTHORITY: 'https://login.example.test' } });
    const text = describeIssues(blockingIssues(projects[0]));
    assert.match(text, /MCP server URL is missing \(set MCP_URL or mcplab.serverUrl\)/);
    assert.match(text, /client id is missing \(set MCP_OAUTH_CLIENT_ID or mcplab.oauth.clientId\)/);
    assert.match(text, /No OAuth scopes are configured \(set MCP_OAUTH_SCOPES or mcplab.oauth.scopes\)/);
  });

  it('refuses plain HTTP anywhere but the local machine', () => {
    assert.match(describeIssues(blockingIssues(one('http://mcp.example.test/mcp'))), /must use HTTPS/);
    assert.deepEqual(blockingIssues(one('http://127.0.0.1:8080/mcp')), []);
    assert.deepEqual(blockingIssues(one('http://localhost:8080/mcp')), []);
  });

  it('refuses a .well-known metadata URL used as the MCP endpoint', () => {
    const project = one('https://mcp.example.test/.well-known/oauth-protected-resource');
    assert.match(describeIssues(blockingIssues(project)), /\.well-known/);
  });

  it('checks the URLs that steer discovery', () => {
    const project = one('https://mcp.example.test/mcp', {
      ...base,
      authority: 'http://login.example.test',
      discoveryUrl: 'https://mcp.example.test/mcp',
    });
    const text = describeIssues(blockingIssues(project));
    assert.match(text, /oauth.authority must be an HTTPS URL/);
    assert.match(text, /oauth.discoveryUrl must not be the MCP server URL itself/);
  });

  it('only allows http redirect URIs that point at this machine', () => {
    const remote = one('https://mcp.example.test/mcp', { ...base, redirectUri: 'http://example.test/cb' });
    assert.match(describeIssues(blockingIssues(remote)), /must point at 127.0.0.1/);
    assert.deepEqual(
      blockingIssues(one('https://mcp.example.test/mcp', { ...base, redirectUri: 'http://127.0.0.1:33418/auth/callback' })),
      [],
    );
    assert.deepEqual(
      blockingIssues(one('https://mcp.example.test/mcp', { ...base, redirectUri: 'vscode://sarathkumar.mcplab/auth/callback' })),
      [],
    );
  });

  it('wants trusted hosts as host names, not URLs', () => {
    const project = one('https://mcp.example.test/mcp', { ...base, trustedHosts: ['https://login.example.test/'] });
    assert.match(describeIssues(blockingIssues(project)), /bare host names/);
  });

  it('does not require a client id for a server added by hand, which can register itself', () => {
    const project = adhocProject({ id: 'adhoc', name: 'Ad hoc', transport: 'http', url: 'https://mcp.example.test/mcp' });
    assert.equal(project.origin, 'adhoc');
    assert.deepEqual(blockingIssues(project), []);
  });
});

describe('projects: isolation', () => {
  const resolve = (oauth: Record<string, unknown>, mcpUrl = 'https://mcp.example.test/mcp') =>
    resolveProjects({ projects: [{ id: 'p', mcpUrl, oauth: { scopes: ['s'], ...oauth } }], env: {} }).projects[0];

  it('binds a session to endpoint, resource and client', () => {
    const original = bindingKey(resolve({ clientId: 'a' }));
    assert.equal(bindingKey(resolve({ clientId: 'a' })), original, 'stable for the same configuration');
    assert.notEqual(bindingKey(resolve({ clientId: 'b' })), original);
    assert.notEqual(bindingKey(resolve({ clientId: 'a', resource: 'api://other' })), original);
    assert.notEqual(bindingKey(resolve({ clientId: 'a' }, 'https://mcp.example.test/other')), original);
    // Behavioural switches do not invalidate a session.
    assert.equal(bindingKey(resolve({ clientId: 'a', callbackMode: 'loopback' })), original);
  });
});

describe('projects: workspace overrides', () => {
  it('finds security-sensitive keys a workspace sets, and ignores the rest', () => {
    const result = findWorkspaceOverrides([
      { key: 'oauth.authority', workspaceValue: 'https://login.attacker.example' },
      { key: 'serverUrl' },
      { key: 'requestTimeoutMs', workspaceValue: 5000 },
    ]);
    assert.deepEqual(result.keys, ['oauth.authority']);
    assert.ok(result.fingerprint);
  });

  it('changes the fingerprint when the workspace changes the value', () => {
    const first = findWorkspaceOverrides([{ key: 'serverUrl', workspaceValue: 'https://a.example.test/mcp' }]);
    const second = findWorkspaceOverrides([{ key: 'serverUrl', workspaceValue: 'https://b.example.test/mcp' }]);
    assert.notEqual(first.fingerprint, second.fingerprint);
  });

  it('holds back exactly the projects an unapproved override affects', () => {
    const input = {
      env: ENV,
      projects: [{ id: 'team', mcpUrl: 'https://mcp.example.test/mcp', oauth: { clientId: 'c', scopes: ['s'] } }],
    };
    const settingsOverride = resolveProjects({ ...input, workspaceOverrides: { keys: ['oauth.authority'], approved: false } });
    assert.deepEqual(settingsOverride.projects.find((p) => p.id === DEFAULT_PROJECT_ID)!.pendingApproval, ['mcplab.oauth.authority']);
    assert.equal(settingsOverride.projects.find((p) => p.id === 'team')!.pendingApproval, undefined);

    const projectsOverride = resolveProjects({ ...input, workspaceOverrides: { keys: ['projects'], approved: false } });
    assert.deepEqual(projectsOverride.projects.find((p) => p.id === 'team')!.pendingApproval, ['mcplab.projects']);

    const approved = resolveProjects({ ...input, workspaceOverrides: { keys: ['projects'], approved: true } });
    assert.ok(approved.projects.every((project) => !project.pendingApproval));
  });
});

describe('projects: ${env:NAME}', () => {
  it('expands references and reports the ones that are unset', () => {
    assert.deepEqual(substituteEnv('https://${env:HOST}/mcp', { HOST: 'x.example.test' }), {
      value: 'https://x.example.test/mcp',
      variables: ['HOST'],
      missing: [],
    });
    const missing = substituteEnv('${env:NOPE}', {});
    assert.equal(missing.value, undefined);
    assert.deepEqual(missing.missing, ['NOPE']);
  });

  it('treats a variable set to an empty string as unset', () => {
    assert.deepEqual(substituteEnv('${env:EMPTY}', { EMPTY: '' }).missing, ['EMPTY']);
  });
});
