import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

/**
 * End-to-end: runs the compiled CLI as a real process against the demo
 * environment. This is the test that would fail if the core ever grew a
 * dependency on VS Code, because nothing here loads the extension.
 */

const CLI = path.resolve('out/src/cli/main.js');
const DEMO = path.resolve('demo');

function run(args: string[], cwd = DEMO): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('mcplab CLI', () => {
  it('is built before these tests run', () => {
    assert.ok(existsSync(CLI), `${CLI} is missing; run the TypeScript build first`);
    assert.ok(existsSync(path.join(DEMO, 'mcp.config.json')), 'demo environment is present');
  });

  it('prints usage and exits 2 with no command', () => {
    const result = run([]);
    assert.equal(result.status, 2);
    assert.match(result.stdout, /mcplab <command>/);
  });

  it('exits 2 when the config does not exist', () => {
    const result = run(['doctor', '--config', 'nope.json']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Could not read/);
  });

  it('runs the demo test suites and exits 1 on a real failure', () => {
    const result = run(['test', '--config', 'mcp.config.json', '--server', 'CMS MCP']);

    assert.match(result.stdout, /lists events for QC/);
    assert.match(result.stdout, /rejects a missing environment/);
    // The demo deliberately ships one failing latency budget.
    assert.match(result.stdout, /Took \d+ms, budget is 500ms/);
    assert.equal(result.status, 1, 'a failing test means a failing pipeline');
  });

  it('passes for a suite with no planted failures', () => {
    const result = run(['test', '--config', 'mcp.config.json', '--server', 'Deployment MCP']);
    assert.match(result.stdout, /3 passed, 0 failed/);
    assert.equal(result.status, 0);
  });

  it('writes a JUnit report a CI server can read', () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'mcp-cli-'));
    try {
      const report = path.join(scratch, 'report.xml');
      run(['test', '--config', 'mcp.config.json', '--server', 'Deployment MCP', '--junit', report]);

      const xml = require('node:fs').readFileSync(report, 'utf8') as string;
      assert.match(xml, /<testsuites>/);
      assert.match(xml, /<testsuite name="Deployment checks"/);
      assert.match(xml, /<testcase name="QC pipeline succeeded"/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('diagnoses a server and reports its planted problems', () => {
    const result = run(['doctor', '--config', 'mcp.config.json', '--server', 'CMS MCP']);

    assert.match(result.stdout, /Server reachable/);
    assert.match(result.stdout, /Protocol version negotiated: 2025-06-18/);
    assert.match(result.stdout, /apiKey/, 'the credential-returning tool is caught');
    assert.match(result.stdout, /deleteEvent.*destructiveHint/s);
    assert.equal(result.status, 1, 'an error-level finding fails the run');
  });

  it('lints, and honours a warning budget', () => {
    const clean = run(['lint', '--config', 'mcp.config.json', '--server', 'Deployment MCP']);
    assert.equal(clean.status, 0, 'the well-behaved server lints clean');

    const employee = run(['lint', '--config', 'mcp.config.json', '--server', 'Employee MCP']);
    assert.match(employee.stdout, /MCP005/);
    assert.equal(employee.status, 1, 'an error-level rule fails the run');

    // The deployment server lints clean of errors but has one warning
    // (getHealth has no test), so the budget is what decides the exit code.
    const strict = run([
      'lint',
      '--config',
      'mcp.config.json',
      '--server',
      'Deployment MCP',
      '--max-warnings',
      '0',
    ]);
    assert.equal(strict.status, 1, 'a zero-warning budget fails');
    assert.match(strict.stdout, /warning budget exceeded/);

    const lenient = run([
      'lint',
      '--config',
      'mcp.config.json',
      '--server',
      'Deployment MCP',
      '--max-warnings',
      '5',
    ]);
    assert.equal(lenient.status, 0, 'a budget above the warning count passes');
  });

  it('generates documentation from the live catalog', () => {
    const result = run(['docs', '--config', 'mcp.config.json', '--server', 'Deployment MCP']);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /# Deployment MCP/);
    assert.match(result.stdout, /### `rollbackDeployment`/);
    assert.match(result.stdout, /⚠️ \*\*Destructive\.\*\*/);
    assert.match(result.stdout, /\| `environment` \|/);
  });

  it('emits machine-readable output for a pipeline to consume', () => {
    const result = run(['lint', '--config', 'mcp.config.json', '--server', 'Employee MCP', '--json']);
    const start = result.stdout.indexOf('[');
    const parsed = JSON.parse(result.stdout.slice(start)) as Array<{ rule: string }>;
    assert.ok(parsed.some((finding) => finding.rule === 'MCP005'));
  });

  it('reports a server it cannot reach instead of hanging', () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'mcp-cli-'));
    try {
      const config = path.join(scratch, 'mcp.config.json');
      require('node:fs').writeFileSync(
        config,
        JSON.stringify({
          servers: [
            {
              id: 'ghost',
              name: 'Ghost MCP',
              transport: 'stdio',
              command: 'definitely-not-a-real-binary-xyz',
            },
          ],
        }),
      );

      const result = run(['doctor', '--config', config], scratch);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /could not connect/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
