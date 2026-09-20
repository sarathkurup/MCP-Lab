/**
 * `mcp-workbench` CLI.
 *
 * This exists because `src/core` has no VS Code dependency: the same engine
 * that powers the extension runs tests, lints and diagnoses a server from a
 * pipeline, with no editor installed.
 *
 *   mcp-workbench test   --config mcp.config.json [--server NAME] [--junit out.xml]
 *   mcp-workbench lint   --config mcp.config.json [--max-warnings N]
 *   mcp-workbench doctor --config mcp.config.json
 *   mcp-workbench docs   --config mcp.config.json [--out README.md]
 *
 * Exit codes: 0 success, 1 failures found, 2 could not run.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ConnectionManager } from '../core/ConnectionManager';
import type { ServerConfig } from '../core/config';
import { diagnose } from '../core/doctor';
import { generateDocs } from '../core/docs';
import { ExecutionService } from '../core/execution';
import { HistoryStore } from '../core/history';
import { lint, summarize, type LintFinding } from '../core/linter';
import { LogStore } from '../core/logging';
import { parseSuite, TestRunner, type SuiteResult, type TestSuite } from '../core/testing';
import { TraceStore } from '../core/trace';

interface CliOptions {
  command: string;
  config: string;
  server?: string;
  junit?: string;
  out?: string;
  maxWarnings?: number;
  testsDir: string;
  verbose: boolean;
  json: boolean;
}

interface CliConfig {
  servers: ServerConfig[];
}

const EXIT_OK = 0;
const EXIT_FAILURES = 1;
const EXIT_ERROR = 2;

async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  if (!options) {
    printUsage();
    return EXIT_ERROR;
  }

  let config: CliConfig;
  try {
    config = loadConfig(options.config);
  } catch (err) {
    console.error(`Could not read ${options.config}: ${message(err)}`);
    return EXIT_ERROR;
  }

  const servers = options.server
    ? config.servers.filter(
        (s) => s.name === options.server || s.id === options.server,
      )
    : config.servers;

  if (servers.length === 0) {
    console.error(
      options.server
        ? `No server named "${options.server}" in ${options.config}`
        : `No servers defined in ${options.config}`,
    );
    return EXIT_ERROR;
  }

  const logs = new LogStore();
  const trace = new TraceStore(500);
  const manager = new ConnectionManager({
    logs,
    trace,
    requestTimeoutMs: () => 30_000,
  });

  if (options.verbose) {
    logs.onDidLog((entry) => console.error(`  [${entry.level}] ${entry.message}`));
  }

  try {
    await manager.sync(servers.map((server, index) => ({ ...server, id: server.id ?? `s${index}` })));

    let exitCode = EXIT_OK;
    for (const connection of manager.list()) {
      process.stdout.write(`\n${connection.config.name}\n`);
      try {
        await connection.connect();
      } catch (err) {
        console.error(`  ✘ could not connect: ${message(err)}`);
        exitCode = EXIT_FAILURES;
        continue;
      }

      switch (options.command) {
        case 'test':
          exitCode = Math.max(exitCode, await runTests(manager, connection.id, options));
          break;
        case 'lint':
          exitCode = Math.max(exitCode, runLint(manager, connection.id, options));
          break;
        case 'doctor':
          exitCode = Math.max(exitCode, await runDoctor(manager, connection.id, options));
          break;
        case 'docs':
          exitCode = Math.max(exitCode, runDocs(manager, connection.id, options));
          break;
        default:
          console.error(`Unknown command "${options.command}"`);
          return EXIT_ERROR;
      }
    }
    return exitCode;
  } finally {
    await manager.disposeAll();
  }
}

// ---------------------------------------------------------------------------

async function runTests(
  manager: ConnectionManager,
  serverId: string,
  options: CliOptions,
): Promise<number> {
  const suites = loadSuites(options.testsDir);
  if (suites.length === 0) {
    console.error(`  no suites found under ${options.testsDir}`);
    return EXIT_OK;
  }

  const connection = manager.get(serverId)!;
  const runner = new TestRunner(new ExecutionService(manager, new HistoryStore()));
  const results: SuiteResult[] = [];

  for (const suite of suites) {
    // A suite that names a different server is skipped rather than failed.
    if (suite.server && suite.server !== connection.config.name && suite.server !== serverId) {
      continue;
    }
    const result = await runner.runSuite(suite, serverId, {
      onResult: (single) => {
        const glyph =
          single.status === 'passed' ? '✔' : single.status === 'skipped' ? '–' : '✘';
        process.stdout.write(`  ${glyph} ${single.test.name} (${single.durationMs}ms)\n`);
        if (single.message) {
          process.stdout.write(`      ${single.message}\n`);
        }
      },
    });
    results.push(result);
  }

  const passed = results.reduce((sum, r) => sum + r.passed, 0);
  const failed = results.reduce((sum, r) => sum + r.failed, 0);
  const skipped = results.reduce((sum, r) => sum + r.skipped, 0);
  process.stdout.write(`  ${passed} passed, ${failed} failed, ${skipped} skipped\n`);

  if (options.junit) {
    writeFileSync(options.junit, toJUnit(results), 'utf8');
    process.stdout.write(`  JUnit report: ${options.junit}\n`);
  }
  if (options.json) {
    process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  }

  return failed > 0 ? EXIT_FAILURES : EXIT_OK;
}

function runLint(manager: ConnectionManager, serverId: string, options: CliOptions): number {
  const connection = manager.get(serverId)!;
  const tested = new Set<string>();
  for (const suite of loadSuites(options.testsDir)) {
    for (const test of suite.tests) {
      if (test.tool) {
        tested.add(`tool:${test.tool}`);
      }
    }
  }

  const findings = lint({
    tools: connection.catalog.tools,
    resources: connection.catalog.resources,
    prompts: connection.catalog.prompts,
    testedTargets: tested.size > 0 ? tested : undefined,
  });

  for (const finding of findings) {
    process.stdout.write(
      `  ${severityGlyph(finding)} ${finding.rule} ${finding.target.name}: ${finding.message}\n`,
    );
  }

  const counts = summarize(findings);
  process.stdout.write(
    `  ${counts.errors} error(s), ${counts.warnings} warning(s), ${counts.info} info\n`,
  );
  if (options.json) {
    process.stdout.write(JSON.stringify(findings, null, 2) + '\n');
  }

  if (counts.errors > 0) {
    return EXIT_FAILURES;
  }
  if (options.maxWarnings !== undefined && counts.warnings > options.maxWarnings) {
    process.stdout.write(`  warning budget exceeded (max ${options.maxWarnings})\n`);
    return EXIT_FAILURES;
  }
  return EXIT_OK;
}

async function runDoctor(
  manager: ConnectionManager,
  serverId: string,
  options: CliOptions,
): Promise<number> {
  const report = await diagnose(manager.get(serverId)!, { probe: true });
  for (const check of report.checks) {
    const glyph =
      check.status === 'pass' ? '✔' : check.status === 'warn' ? '⚠' : check.status === 'fail' ? '✘' : '–';
    process.stdout.write(`  ${glyph} [${check.group}] ${check.title}: ${check.detail}\n`);
  }
  process.stdout.write(
    `  ${report.passed} passed, ${report.warnings} warning(s), ${report.errors} error(s)\n`,
  );
  if (options.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  }
  return report.errors > 0 ? EXIT_FAILURES : EXIT_OK;
}

function runDocs(manager: ConnectionManager, serverId: string, options: CliOptions): number {
  const connection = manager.get(serverId)!;
  const markdown = generateDocs({
    name: connection.config.name,
    serverInfo: connection.serverInfo,
    protocolVersion: connection.protocolVersion,
    instructions: connection.instructions,
    capabilities: connection.capabilities,
    tools: connection.catalog.tools,
    resources: connection.catalog.resources,
    resourceTemplates: connection.catalog.resourceTemplates,
    prompts: connection.catalog.prompts,
  });

  if (options.out) {
    writeFileSync(options.out, markdown, 'utf8');
    process.stdout.write(`  wrote ${options.out}\n`);
  } else {
    process.stdout.write(markdown + '\n');
  }
  return EXIT_OK;
}

// ---------------------------------------------------------------------------

function loadConfig(path: string): CliConfig {
  const raw = JSON.parse(readFileSync(resolve(path), 'utf8')) as Partial<CliConfig> & {
    mcpServers?: Record<string, Partial<ServerConfig>>;
  };

  if (Array.isArray(raw.servers)) {
    return { servers: raw.servers as ServerConfig[] };
  }

  // Also accept the `mcpServers` object shape other MCP clients use.
  if (raw.mcpServers) {
    return {
      servers: Object.entries(raw.mcpServers).map(([name, server]) => ({
        id: name,
        name,
        transport: server.url ? 'http' : 'stdio',
        ...server,
      })) as ServerConfig[],
    };
  }

  throw new Error('config needs a "servers" array or an "mcpServers" object');
}

function loadSuites(dir: string): TestSuite[] {
  const root = resolve(dir);
  const suites: TestSuite[] = [];

  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== 'node_modules' && !entry.startsWith('.')) {
          walk(full);
        }
        continue;
      }
      if (!entry.endsWith('.json')) {
        continue;
      }
      try {
        suites.push(parseSuite(JSON.parse(readFileSync(full, 'utf8')), entry, full));
      } catch (err) {
        console.error(`  ! skipping ${full}: ${message(err)}`);
      }
    }
  };

  walk(root);
  return suites;
}

function toJUnit(results: SuiteResult[]): string {
  const escape = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const suites = results
    .map((suite) => {
      const cases = suite.results
        .map((result) => {
          const time = (result.durationMs / 1000).toFixed(3);
          const open = `<testcase name="${escape(result.test.name)}" classname="${escape(suite.suite.name)}" time="${time}">`;
          if (result.status === 'passed') {
            return `${open}</testcase>`;
          }
          if (result.status === 'skipped') {
            return `${open}<skipped/></testcase>`;
          }
          const tag = result.status === 'errored' ? 'error' : 'failure';
          return `${open}<${tag} message="${escape(result.message ?? 'failed')}"/></testcase>`;
        })
        .join('\n    ');

      return `  <testsuite name="${escape(suite.suite.name)}" tests="${suite.results.length}" failures="${suite.failed}" skipped="${suite.skipped}" time="${(suite.durationMs / 1000).toFixed(3)}">
    ${cases}
  </testsuite>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n${suites}\n</testsuites>\n`;
}

function parseArgs(argv: string[]): CliOptions | undefined {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') {
    return undefined;
  }

  const options: CliOptions = {
    command,
    config: 'mcp.config.json',
    testsDir: 'mcp-tests',
    verbose: false,
    json: false,
  };

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const next = () => rest[++i];
    switch (arg) {
      case '--config':
        options.config = next();
        break;
      case '--server':
        options.server = next();
        break;
      case '--tests':
        options.testsDir = next();
        break;
      case '--junit':
        options.junit = next();
        break;
      case '--out':
        options.out = next();
        break;
      case '--max-warnings':
        options.maxWarnings = Number(next());
        break;
      case '--verbose':
        options.verbose = true;
        break;
      case '--json':
        options.json = true;
        break;
      default:
        console.error(`Unknown option "${arg}"`);
        return undefined;
    }
  }

  return options;
}

function printUsage(): void {
  process.stdout.write(
    [
      'mcp-workbench <command> [options]',
      '',
      'Commands:',
      '  test     Run declarative MCP test suites',
      '  lint     Static analysis of the advertised catalog',
      '  doctor   Connectivity, protocol, security and coverage checks',
      '  docs     Generate Markdown documentation from the live server',
      '',
      'Options:',
      '  --config <file>      Server definitions (default mcp.config.json)',
      '  --server <name>      Only this server',
      '  --tests <dir>        Test directory (default mcp-tests)',
      '  --junit <file>       Write a JUnit XML report',
      '  --out <file>         Write docs output to a file',
      '  --max-warnings <n>   Fail lint above this many warnings',
      '  --json               Emit machine-readable output',
      '  --verbose            Stream server logs to stderr',
      '',
      'Exit codes: 0 ok, 1 failures found, 2 could not run',
      '',
    ].join('\n'),
  );
}

function severityGlyph(finding: LintFinding): string {
  return finding.severity === 'error' ? '✘' : finding.severity === 'warning' ? '⚠' : 'ℹ';
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(message(err));
    process.exitCode = EXIT_ERROR;
  });
