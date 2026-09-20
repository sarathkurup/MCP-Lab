import type { AuthConfig } from './auth';
import type { ServerConfig } from './config';
import { classifyTool } from './environments';
import type { HistoryEntry } from './history';
import type { LogEntry } from './logging';
import type { JsonSchema, Prompt, Resource, Tool } from './protocol';

/**
 * Security review of a server as McpLab can actually observe it: the
 * configuration, the advertised catalog, and what has already flowed through
 * the logs and history in this session.
 *
 * It cannot see server source, so it never claims to. Every finding names the
 * evidence it is based on.
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export interface SecurityFinding {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  evidence: 'config' | 'catalog' | 'logs' | 'history';
  target?: string;
  remediation: string;
}

export interface SecurityScanInput {
  config: ServerConfig;
  tools: Tool[];
  resources: Resource[];
  prompts: Prompt[];
  logs: LogEntry[];
  history: HistoryEntry[];
  hasStoredCredential: boolean;
  environmentTier?: 'dev' | 'qc' | 'uat' | 'prod';
}

export interface SecurityReport {
  serverName: string;
  timestamp: number;
  findings: SecurityFinding[];
  counts: Record<Severity, number>;
}

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'JSON Web Token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: 'private key block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'bearer credential', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*\b/ },
  {
    name: 'assignment to a secret-looking name',
    pattern: /\b(?:password|passwd|secret|api[_-]?key|token|credential)\s*[:=]\s*["']?[^\s"',}]{8,}/i,
  },
];

const PII_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'email address', pattern: /\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/ },
  { name: 'card-like number', pattern: /\b(?:\d[ -]?){13,16}\b/ },
  { name: 'US social security number', pattern: /\b\d{3}-\d{2}-\d{4}\b/ },
];

const SENSITIVE_FIELD = /(password|passwd|secret|token|api[_-]?key|credential|private[_-]?key|ssn|card)/i;

export function scanSecurity(input: SecurityScanInput): SecurityReport {
  const findings: SecurityFinding[] = [];

  findings.push(...scanConfig(input));
  findings.push(...scanCatalog(input));
  findings.push(...scanLogs(input));
  findings.push(...scanHistory(input));

  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const finding of findings) {
    counts[finding.severity]++;
  }

  return {
    serverName: input.config.name,
    timestamp: Date.now(),
    findings: findings.sort((a, b) => rank(b.severity) - rank(a.severity)),
    counts,
  };
}

function scanConfig(input: SecurityScanInput): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const { config } = input;

  if (config.transport === 'http' && config.url) {
    const loopback = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(config.url);
    if (config.url.startsWith('http://') && !loopback) {
      findings.push({
        id: 'SEC001',
        severity: 'critical',
        title: 'Credentials travel over plain HTTP',
        detail: `${config.url} is not encrypted. Any token sent to it is readable in transit.`,
        evidence: 'config',
        remediation: 'Use https, or a loopback address for local development.',
      });
    }
  }

  // A secret pasted into a settings file is the most common real-world leak.
  for (const [name, value] of Object.entries(config.headers ?? {})) {
    if (looksSecret(name, value)) {
      findings.push({
        id: 'SEC002',
        severity: 'critical',
        title: 'Credential in a plain-text header setting',
        detail: `Header "${name}" holds what looks like a credential. Settings files are synced and committed.`,
        evidence: 'config',
        target: name,
        remediation: 'Remove it and use "MCP: Set Authentication Token", which stores it in SecretStorage.',
      });
    }
  }

  for (const [name, value] of Object.entries(config.env ?? {})) {
    if (looksSecret(name, value)) {
      findings.push({
        id: 'SEC003',
        severity: 'high',
        title: 'Credential in a process environment setting',
        detail: `Environment variable "${name}" appears to contain a secret in the server definition.`,
        evidence: 'config',
        target: name,
        remediation: 'Reference an existing machine environment variable instead of inlining the value.',
      });
    }
  }

  if (config.transport === 'http' && !input.hasStoredCredential && authKind(config.auth) !== 'none') {
    findings.push({
      id: 'SEC004',
      severity: 'medium',
      title: 'No credential configured for a remote server',
      detail: 'Either the endpoint is unauthenticated, or calls will fail with 401.',
      evidence: 'config',
      remediation: 'Store a credential, or confirm the endpoint is intentionally public.',
    });
  }

  if (input.environmentTier === 'prod' && config.autoConnect) {
    findings.push({
      id: 'SEC005',
      severity: 'medium',
      title: 'Auto-connect is enabled against production',
      detail: 'MCP Lab will open a production session as soon as the editor starts.',
      evidence: 'config',
      remediation: 'Disable autoConnect for production environments.',
    });
  }

  return findings;
}

function scanCatalog(input: SecurityScanInput): SecurityFinding[] {
  const findings: SecurityFinding[] = [];

  for (const tool of input.tools) {
    const risk = classifyTool(tool);

    walkSchema(tool.inputSchema, '', (path, name) => {
      if (SENSITIVE_FIELD.test(name)) {
        findings.push({
          id: 'SEC010',
          severity: 'high',
          title: 'Tool accepts a credential as a parameter',
          detail: `"${tool.name}" declares \`${path}\`. Arguments are logged, traced and placed in model context.`,
          evidence: 'catalog',
          target: tool.name,
          remediation: 'Configure the credential server-side rather than passing it per call.',
        });
      }
    });

    if (tool.outputSchema) {
      walkSchema(tool.outputSchema, '', (path, name) => {
        if (SENSITIVE_FIELD.test(name)) {
          findings.push({
            id: 'SEC011',
            severity: 'high',
            title: 'Tool returns a sensitive field',
            detail: `"${tool.name}" returns \`${path}\`, which is fed straight into model context.`,
            evidence: 'catalog',
            target: tool.name,
            remediation: 'Redact the field server-side before returning it.',
          });
        }
      });
    }

    if (risk === 'destructive' && tool.annotations?.destructiveHint !== true) {
      findings.push({
        id: 'SEC012',
        severity: 'high',
        title: 'Unannotated destructive tool',
        detail: `"${tool.name}" looks destructive but carries no destructiveHint, so clients will not ask a human first.`,
        evidence: 'catalog',
        target: tool.name,
        remediation: 'Add annotations.destructiveHint = true.',
      });
    }

    const properties = Object.keys(tool.inputSchema?.properties ?? {});
    if (risk !== 'read' && properties.length > 0 && (tool.inputSchema?.required ?? []).length === 0) {
      findings.push({
        id: 'SEC013',
        severity: 'low',
        title: 'Write tool with no required parameters',
        detail: `"${tool.name}" can be invoked with an empty payload, which often means an unscoped operation.`,
        evidence: 'catalog',
        target: tool.name,
        remediation: 'Require the identifier the operation acts on.',
      });
    }

    if (/\b(sql|query|exec|eval|command|shell)\b/i.test(tool.name) && risk !== 'read') {
      findings.push({
        id: 'SEC014',
        severity: 'medium',
        title: 'Tool may execute arbitrary input',
        detail: `"${tool.name}" looks like it forwards caller-supplied code or queries to a backend.`,
        evidence: 'catalog',
        target: tool.name,
        remediation: 'Constrain it to named operations, or require parameterized input.',
      });
    }
  }

  for (const resource of input.resources) {
    if (resource.uri.startsWith('file:///') && /\/(etc|root|home|users)\//i.test(resource.uri)) {
      findings.push({
        id: 'SEC015',
        severity: 'medium',
        title: 'Resource exposes a sensitive filesystem path',
        detail: `${resource.uri} is outside a project directory.`,
        evidence: 'catalog',
        target: resource.uri,
        remediation: 'Scope resources to the working directory.',
      });
    }
  }

  return findings;
}

function scanLogs(input: SecurityScanInput): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const seen = new Set<string>();

  for (const entry of input.logs) {
    for (const { name, pattern } of SECRET_PATTERNS) {
      if (pattern.test(entry.message) && !seen.has(`secret:${name}`)) {
        seen.add(`secret:${name}`);
        findings.push({
          id: 'SEC020',
          severity: 'critical',
          title: 'Credential written to logs',
          detail: `A ${name} appeared in this server's log output.`,
          evidence: 'logs',
          remediation: 'Redact credentials before logging; log output is retained and often shipped off-box.',
        });
      }
    }
    for (const { name, pattern } of PII_PATTERNS) {
      if (pattern.test(entry.message) && !seen.has(`pii:${name}`)) {
        seen.add(`pii:${name}`);
        findings.push({
          id: 'SEC021',
          severity: 'medium',
          title: 'Personal data in logs',
          detail: `A ${name} appeared in this server's log output.`,
          evidence: 'logs',
          remediation: 'Mask personal data in log lines.',
        });
      }
    }
  }

  return findings;
}

function scanHistory(input: SecurityScanInput): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const seenTools = new Set<string>();

  for (const entry of input.history) {
    const serialized = safeStringify(entry.output);
    for (const { name, pattern } of SECRET_PATTERNS) {
      if (pattern.test(serialized) && !seenTools.has(`${entry.name}:${name}`)) {
        seenTools.add(`${entry.name}:${name}`);
        findings.push({
          id: 'SEC030',
          severity: 'critical',
          title: 'Tool response contained a credential',
          detail: `"${entry.name}" returned a ${name}. Responses are stored in history and passed to models.`,
          evidence: 'history',
          target: entry.name,
          remediation: 'Redact the value server-side, then clear MCP Lab history.',
        });
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------

function looksSecret(name: string, value: string): boolean {
  if (SENSITIVE_FIELD.test(name) && value.length >= 8 && !value.startsWith('${')) {
    return true;
  }
  return SECRET_PATTERNS.some(({ pattern }) => pattern.test(value));
}

function authKind(auth: AuthConfig | undefined): string {
  return auth?.kind ?? 'bearer';
}

function walkSchema(
  schema: JsonSchema | undefined,
  path: string,
  visit: (path: string, name: string) => void,
  depth = 0,
): void {
  if (!schema || depth > 6) {
    return;
  }
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    const childPath = path ? `${path}.${name}` : name;
    visit(childPath, name);
    walkSchema(property, childPath, visit, depth + 1);
  }
  const items = Array.isArray(schema.items) ? schema.items[0] : schema.items;
  if (items) {
    walkSchema(items, `${path}[]`, visit, depth + 1);
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function rank(severity: Severity): number {
  return { critical: 4, high: 3, medium: 2, low: 1 }[severity];
}
