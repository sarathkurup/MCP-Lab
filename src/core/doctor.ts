import { lint, type LintFinding } from './linter';
import type { McpConnection } from './McpConnection';
import { McpError } from './protocol';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface DiagnosticCheck {
  id: string;
  group: string;
  title: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
  /** A command id the UI can offer as a one-click remedy. */
  fixCommand?: string;
}

export interface DiagnosticReport {
  serverId: string;
  serverName: string;
  timestamp: number;
  checks: DiagnosticCheck[];
  findings: LintFinding[];
  passed: number;
  warnings: number;
  errors: number;
}

export interface DoctorOptions {
  /** Send live probes (ping, unknown-tool error handling). Defaults to true. */
  probe?: boolean;
  /** `tool:name` keys that already have tests, for the coverage check. */
  testedTargets?: Set<string>;
  /** Whether a credential is stored for this server. */
  hasCredential?: boolean;
}

/**
 * Twelve checks across connectivity, protocol, catalog quality, security and
 * coverage. Probes are read-only by construction: a ping and a deliberately
 * unknown tool name, never a call to a tool the server actually exposes.
 */
export async function diagnose(
  connection: McpConnection,
  options: DoctorOptions = {},
): Promise<DiagnosticReport> {
  const checks: DiagnosticCheck[] = [];
  const probe = options.probe !== false;

  // -- connectivity ---------------------------------------------------------

  if (connection.status !== 'connected') {
    checks.push({
      id: 'connectivity',
      group: 'Connectivity',
      title: 'Server reachable',
      status: 'fail',
      detail: connection.lastError ?? `Server is ${connection.status}`,
      hint: 'Everything below needs a live connection.',
      fixCommand: 'mcpilot.connect',
    });
    return finish(connection, checks, []);
  }

  checks.push({
    id: 'connectivity',
    group: 'Connectivity',
    title: 'Server reachable',
    status: 'pass',
    detail: `Connected over ${connection.config.transport}`,
  });

  const client = connection.activeClient!;

  if (probe) {
    const started = Date.now();
    try {
      await client.ping();
      const elapsed = Date.now() - started;
      checks.push({
        id: 'ping',
        group: 'Connectivity',
        title: 'Responds to ping',
        status: elapsed > 1000 ? 'warn' : 'pass',
        detail: `Round trip ${elapsed}ms`,
        hint: elapsed > 1000 ? 'A slow ping usually means the server blocks its event loop.' : undefined,
      });
    } catch (err) {
      // ping is optional in practice; a method-not-found is not a failure.
      const notImplemented = err instanceof McpError && err.code === -32601;
      checks.push({
        id: 'ping',
        group: 'Connectivity',
        title: 'Responds to ping',
        status: notImplemented ? 'warn' : 'fail',
        detail: notImplemented
          ? 'Server does not implement ping'
          : err instanceof Error
            ? err.message
            : String(err),
      });
    }
  }

  // -- protocol -------------------------------------------------------------

  checks.push({
    id: 'protocol',
    group: 'Protocol',
    title: 'Protocol version negotiated',
    status: connection.protocolVersion ? 'pass' : 'fail',
    detail: connection.protocolVersion ?? 'No version was negotiated',
  });

  const info = connection.serverInfo;
  checks.push({
    id: 'identity',
    group: 'Protocol',
    title: 'Server identifies itself',
    status: info?.name && info?.version ? 'pass' : 'warn',
    detail: info ? `${info.name} v${info.version}` : 'serverInfo is incomplete',
    hint: 'Name and version are what the catalog and version comparison key off.',
  });

  // -- capabilities ---------------------------------------------------------

  const caps = connection.capabilities ?? {};
  const catalog = connection.catalog;
  const declared = Object.keys(caps).filter((key) => caps[key as keyof typeof caps]);

  checks.push({
    id: 'capabilities',
    group: 'Capabilities',
    title: 'Capabilities declared',
    status: declared.length > 0 ? 'pass' : 'warn',
    detail: declared.length ? declared.join(', ') : 'Server declared no capabilities',
  });

  if (caps.tools) {
    checks.push({
      id: 'tools',
      group: 'Capabilities',
      title: 'Tools discoverable',
      status: catalog.tools.length > 0 ? 'pass' : 'warn',
      detail: `${catalog.tools.length} tool(s)`,
      hint: catalog.tools.length === 0 ? 'The server advertises tools but lists none.' : undefined,
    });
  }
  if (caps.resources) {
    checks.push({
      id: 'resources',
      group: 'Capabilities',
      title: 'Resources discoverable',
      status: catalog.resources.length + catalog.resourceTemplates.length > 0 ? 'pass' : 'warn',
      detail: `${catalog.resources.length} resource(s), ${catalog.resourceTemplates.length} template(s)`,
    });
  }
  if (caps.prompts) {
    checks.push({
      id: 'prompts',
      group: 'Capabilities',
      title: 'Prompts discoverable',
      status: catalog.prompts.length > 0 ? 'pass' : 'warn',
      detail: `${catalog.prompts.length} prompt(s)`,
    });
  }

  checks.push({
    id: 'logging',
    group: 'Capabilities',
    title: 'Logging supported',
    status: caps.logging ? 'pass' : 'warn',
    detail: caps.logging
      ? 'Server can emit structured log notifications'
      : 'No logging capability; only stderr and MCPilot-side events are available',
  });

  // -- error handling -------------------------------------------------------

  if (probe && caps.tools) {
    try {
      await client.callTool('__mcpilot_probe__', {});
      checks.push({
        id: 'errors',
        group: 'Error handling',
        title: 'Unknown tool is rejected',
        status: 'fail',
        detail: 'Calling a tool that does not exist returned success',
        hint: 'A server should answer with a JSON-RPC error or an isError result.',
      });
    } catch (err) {
      const isProtocolError = err instanceof McpError;
      checks.push({
        id: 'errors',
        group: 'Error handling',
        title: 'Unknown tool is rejected',
        status: isProtocolError ? 'pass' : 'warn',
        detail: isProtocolError
          ? `Rejected with code ${(err as McpError).code}`
          : `Rejected, but not as a protocol error: ${String(err)}`,
      });
    }
  }

  // -- schema quality -------------------------------------------------------

  const findings = lint({
    tools: catalog.tools,
    resources: catalog.resources,
    prompts: catalog.prompts,
    testedTargets: options.testedTargets,
  });

  const byRule = (rule: string) => findings.filter((f) => f.rule === rule);

  const schemaErrors = byRule('MCP002');
  checks.push({
    id: 'schemas',
    group: 'Schema',
    title: 'Input schemas are valid',
    status: schemaErrors.length === 0 ? 'pass' : 'fail',
    detail:
      schemaErrors.length === 0
        ? `${catalog.tools.length} schema(s) parsed`
        : schemaErrors.map((f) => f.message).join('; '),
  });

  const missingDescriptions = byRule('MCP001');
  checks.push({
    id: 'descriptions',
    group: 'Schema',
    title: 'Tools are documented',
    status: missingDescriptions.length === 0 ? 'pass' : 'warn',
    detail:
      missingDescriptions.length === 0
        ? 'Every tool and prompt has a description'
        : `${missingDescriptions.length} item(s) missing or thin`,
  });

  // -- security -------------------------------------------------------------

  const sensitive = byRule('MCP005');
  checks.push({
    id: 'sensitive',
    group: 'Security',
    title: 'No credentials in schemas',
    status: sensitive.length === 0 ? 'pass' : 'fail',
    detail:
      sensitive.length === 0
        ? 'No parameter or output field looks like a secret'
        : sensitive.map((f) => f.message).join('; '),
  });

  const unannotated = byRule('MCP004');
  checks.push({
    id: 'destructive',
    group: 'Security',
    title: 'Destructive tools are annotated',
    status: unannotated.length === 0 ? 'pass' : 'warn',
    detail:
      unannotated.length === 0
        ? 'Annotations match the tool names'
        : unannotated.map((f) => f.message).join('; '),
  });

  if (connection.config.transport === 'http') {
    checks.push({
      id: 'auth',
      group: 'Security',
      title: 'Credential configured',
      status: options.hasCredential ? 'pass' : 'warn',
      detail: options.hasCredential
        ? 'A token is stored in SecretStorage'
        : 'No credential stored; the endpoint is either public or will reject calls',
      fixCommand: options.hasCredential ? undefined : 'mcpilot.setAuthToken',
    });
    const url = connection.config.url ?? '';
    const insecure = url.startsWith('http://') && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(url);
    checks.push({
      id: 'transport-security',
      group: 'Security',
      title: 'Transport is encrypted',
      status: insecure ? 'fail' : 'pass',
      detail: insecure ? `${url} is plain HTTP` : 'HTTPS or a loopback address',
    });
  }

  // -- coverage -------------------------------------------------------------

  if (options.testedTargets) {
    const untested = byRule('MCP007');
    checks.push({
      id: 'coverage',
      group: 'Tests',
      title: 'Tools have tests',
      status: untested.length === 0 ? 'pass' : 'warn',
      detail:
        untested.length === 0
          ? `All ${catalog.tools.length} tool(s) are covered`
          : `${untested.length} of ${catalog.tools.length} tool(s) have no test`,
      fixCommand: 'mcpilot.generateTests',
    });
  } else {
    checks.push({
      id: 'coverage',
      group: 'Tests',
      title: 'Tools have tests',
      status: 'skip',
      detail: 'No test suites were discovered in this workspace',
    });
  }

  return finish(connection, checks, findings);
}

function finish(
  connection: McpConnection,
  checks: DiagnosticCheck[],
  findings: LintFinding[],
): DiagnosticReport {
  return {
    serverId: connection.id,
    serverName: connection.config.name,
    timestamp: Date.now(),
    checks,
    findings,
    passed: checks.filter((c) => c.status === 'pass').length,
    warnings: checks.filter((c) => c.status === 'warn').length,
    errors: checks.filter((c) => c.status === 'fail').length,
  };
}
