import type { JsonSchema, Prompt, Resource, Tool } from './protocol';

/**
 * Static analysis of what a server advertises. Runs purely on the catalog, so
 * it works against any server - including one you did not write - and is the
 * same engine the CI command and the editor diagnostics use.
 */

export type LintSeverity = 'error' | 'warning' | 'info';

export interface LintFinding {
  rule: string;
  severity: LintSeverity;
  message: string;
  /** What the finding is about, for grouping and for editor diagnostics. */
  target: { kind: 'tool' | 'resource' | 'prompt' | 'server'; name: string };
  hint?: string;
}

export interface LintInput {
  tools: Tool[];
  resources: Resource[];
  prompts: Prompt[];
  /** Targets that already have at least one test, for MCP007. */
  testedTargets?: Set<string>;
}

export const RULES: Record<string, { title: string; severity: LintSeverity }> = {
  MCP001: { title: 'Missing tool description', severity: 'warning' },
  MCP002: { title: 'Invalid input schema', severity: 'error' },
  MCP003: { title: 'Missing input validation', severity: 'warning' },
  MCP004: { title: 'Dangerous operation not annotated', severity: 'warning' },
  MCP005: { title: 'Possible sensitive data exposure', severity: 'error' },
  MCP006: { title: 'No output schema', severity: 'info' },
  MCP007: { title: 'Missing test', severity: 'warning' },
  MCP008: { title: 'Undocumented parameter', severity: 'info' },
  MCP009: { title: 'Conflicting tool annotations', severity: 'error' },
  MCP010: { title: 'Resource metadata incomplete', severity: 'info' },
  MCP011: { title: 'Undocumented prompt argument', severity: 'info' },
  MCP012: { title: 'Ambiguous tool name', severity: 'info' },
};

const DANGEROUS_NAME = /(^|[_\-.])?(delete|destroy|drop|purge|remove|truncate|wipe|reset|revoke|terminate|rollback)/i;
const SENSITIVE_NAME = /(password|passwd|secret|token|api[_-]?key|credential|private[_-]?key|ssn|credit[_-]?card)/i;

export function lint(input: LintInput): LintFinding[] {
  const findings: LintFinding[] = [];
  const seenNames = new Map<string, number>();

  for (const tool of input.tools) {
    const target = { kind: 'tool' as const, name: tool.name };

    if (!tool.description || tool.description.trim().length < 10) {
      findings.push({
        rule: 'MCP001',
        severity: RULES.MCP001.severity,
        message: tool.description
          ? `"${tool.name}" has a description of only ${tool.description.trim().length} characters`
          : `"${tool.name}" has no description`,
        target,
        hint: 'Clients use the description to decide when to call a tool. One sentence on what it does and when to use it is the minimum.',
      });
    }

    const schema = tool.inputSchema;
    if (!schema || typeof schema !== 'object') {
      findings.push({
        rule: 'MCP002',
        severity: RULES.MCP002.severity,
        message: `"${tool.name}" has no input schema`,
        target,
        hint: 'inputSchema is required by the protocol, even for a tool with no parameters.',
      });
    } else {
      if (schema.type !== 'object') {
        findings.push({
          rule: 'MCP002',
          severity: RULES.MCP002.severity,
          message: `"${tool.name}" input schema is "${String(schema.type ?? 'untyped')}"; MCP requires an object`,
          target,
        });
      }

      const properties = schema.properties ?? {};
      const propertyNames = Object.keys(properties);

      if (propertyNames.length > 0 && (schema.required ?? []).length === 0) {
        findings.push({
          rule: 'MCP003',
          severity: RULES.MCP003.severity,
          message: `"${tool.name}" declares ${propertyNames.length} parameter(s) but none are required`,
          target,
          hint: 'If every parameter is genuinely optional this is fine; otherwise callers get no guidance and errors surface only at runtime.',
        });
      }

      for (const [name, property] of Object.entries(properties)) {
        if (!property.type && !property.enum && !property.anyOf && !property.oneOf) {
          findings.push({
            rule: 'MCP003',
            severity: RULES.MCP003.severity,
            message: `"${tool.name}.${name}" has no declared type`,
            target,
          });
        }
        if (!property.description) {
          findings.push({
            rule: 'MCP008',
            severity: RULES.MCP008.severity,
            message: `"${tool.name}.${name}" has no description`,
            target,
          });
        }
        if (SENSITIVE_NAME.test(name)) {
          findings.push({
            rule: 'MCP005',
            severity: RULES.MCP005.severity,
            message: `"${tool.name}" accepts "${name}", which looks like a credential`,
            target,
            hint: 'Secrets should be configured server-side, not passed as tool arguments where they end up in logs, traces and model context.',
          });
        }
      }

      findSensitiveInOutput(tool, findings);
    }

    const annotations = tool.annotations ?? {};
    if (DANGEROUS_NAME.test(tool.name) && annotations.destructiveHint !== true) {
      findings.push({
        rule: 'MCP004',
        severity: RULES.MCP004.severity,
        message: `"${tool.name}" looks destructive but is not annotated with destructiveHint`,
        target,
        hint: 'Clients use destructiveHint to decide whether to ask a human first.',
      });
    }
    if (annotations.readOnlyHint === true && annotations.destructiveHint === true) {
      findings.push({
        rule: 'MCP009',
        severity: RULES.MCP009.severity,
        message: `"${tool.name}" is annotated both read-only and destructive`,
        target,
      });
    }

    if (!tool.outputSchema) {
      findings.push({
        rule: 'MCP006',
        severity: RULES.MCP006.severity,
        message: `"${tool.name}" declares no output schema`,
        target,
        hint: 'An output schema lets clients validate structured content and lets MCP Lab generate assertions.',
      });
    }

    if (input.testedTargets && !input.testedTargets.has(`tool:${tool.name}`)) {
      findings.push({
        rule: 'MCP007',
        severity: RULES.MCP007.severity,
        message: `"${tool.name}" has no automated test`,
        target,
      });
    }

    const normalized = tool.name.toLowerCase().replace(/[_-]/g, '');
    seenNames.set(normalized, (seenNames.get(normalized) ?? 0) + 1);
  }

  for (const [normalized, count] of seenNames) {
    if (count > 1) {
      findings.push({
        rule: 'MCP012',
        severity: RULES.MCP012.severity,
        message: `${count} tools differ only by case or separators ("${normalized}")`,
        target: { kind: 'server', name: normalized },
        hint: 'Models pick tools by name; near-identical names cause mis-selection.',
      });
    }
  }

  for (const resource of input.resources) {
    if (!resource.description || !resource.mimeType) {
      findings.push({
        rule: 'MCP010',
        severity: RULES.MCP010.severity,
        message: `Resource "${resource.name || resource.uri}" is missing ${
          !resource.description ? 'a description' : 'a mimeType'
        }`,
        target: { kind: 'resource', name: resource.uri },
      });
    }
  }

  for (const prompt of input.prompts) {
    if (!prompt.description) {
      findings.push({
        rule: 'MCP001',
        severity: RULES.MCP001.severity,
        message: `Prompt "${prompt.name}" has no description`,
        target: { kind: 'prompt', name: prompt.name },
      });
    }
    for (const argument of prompt.arguments ?? []) {
      if (!argument.description) {
        findings.push({
          rule: 'MCP011',
          severity: RULES.MCP011.severity,
          message: `Prompt "${prompt.name}" argument "${argument.name}" has no description`,
          target: { kind: 'prompt', name: prompt.name },
        });
      }
    }
  }

  return findings;
}

function findSensitiveInOutput(tool: Tool, findings: LintFinding[]): void {
  const schema = tool.outputSchema;
  if (!schema) {
    return;
  }
  const hits: string[] = [];
  walkSchema(schema, '', (path, name) => {
    if (SENSITIVE_NAME.test(name)) {
      hits.push(path);
    }
  });
  for (const path of hits) {
    findings.push({
      rule: 'MCP005',
      severity: RULES.MCP005.severity,
      message: `"${tool.name}" returns "${path}", which looks sensitive`,
      target: { kind: 'tool', name: tool.name },
      hint: 'Tool results are fed to a model and written to logs and history. Redact before returning.',
    });
  }
}

function walkSchema(
  schema: JsonSchema,
  path: string,
  visit: (path: string, name: string) => void,
  depth = 0,
): void {
  if (depth > 6) {
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

export function summarize(findings: LintFinding[]): {
  errors: number;
  warnings: number;
  info: number;
} {
  return {
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    info: findings.filter((f) => f.severity === 'info').length,
  };
}
