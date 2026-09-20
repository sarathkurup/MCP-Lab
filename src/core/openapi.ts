import type { JsonSchema, Tool, ToolAnnotations } from './protocol';

/**
 * REST -> MCP.
 *
 * Converts an OpenAPI document into MCP tool definitions plus the handler code
 * to back them. Path, query and body parameters collapse into one input schema,
 * because that is what a tool call actually looks like.
 */

export interface OpenApiDocument {
  openapi?: string;
  swagger?: string;
  info?: { title?: string; version?: string; description?: string };
  servers?: Array<{ url: string }>;
  paths?: Record<string, Record<string, OpenApiOperation>>;
  components?: { schemas?: Record<string, JsonSchema> };
  definitions?: Record<string, JsonSchema>;
}

export interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  parameters?: OpenApiParameter[];
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: JsonSchema }>;
  };
  responses?: Record<string, { description?: string; content?: Record<string, { schema?: JsonSchema }> }>;
}

export interface OpenApiParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  description?: string;
  schema?: JsonSchema;
}

export interface GeneratedTool {
  tool: Tool;
  /** How to call the REST endpoint behind it. */
  binding: {
    method: string;
    path: string;
    pathParams: string[];
    queryParams: string[];
    headerParams: string[];
    bodyProperties: string[];
    hasBody: boolean;
  };
  warnings: string[];
}

const METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;

export function toolsFromOpenApi(
  document: OpenApiDocument,
  options: { includeDeprecated?: boolean; tagFilter?: string } = {},
): GeneratedTool[] {
  const generated: GeneratedTool[] = [];
  const schemas = document.components?.schemas ?? document.definitions ?? {};
  const usedNames = new Set<string>();

  for (const [path, operations] of Object.entries(document.paths ?? {})) {
    for (const method of METHODS) {
      const operation = operations[method];
      if (!operation) {
        continue;
      }
      if (operation.deprecated && !options.includeDeprecated) {
        continue;
      }
      if (options.tagFilter && !(operation.tags ?? []).includes(options.tagFilter)) {
        continue;
      }
      generated.push(convert(path, method, operation, schemas, usedNames));
    }
  }

  return generated;
}

function convert(
  path: string,
  method: string,
  operation: OpenApiOperation,
  schemas: Record<string, JsonSchema>,
  usedNames: Set<string>,
): GeneratedTool {
  const warnings: string[] = [];
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  const pathParams: string[] = [];
  const queryParams: string[] = [];
  const headerParams: string[] = [];

  for (const parameter of operation.parameters ?? []) {
    if (parameter.in === 'cookie') {
      warnings.push(`Cookie parameter "${parameter.name}" was skipped.`);
      continue;
    }
    const schema = resolve(parameter.schema ?? { type: 'string' }, schemas);
    properties[parameter.name] = {
      ...schema,
      description: parameter.description ?? schema.description,
    };
    if (parameter.required) {
      required.push(parameter.name);
    }
    if (parameter.in === 'path') {
      pathParams.push(parameter.name);
      // A path parameter is structurally required whatever the document says.
      if (!parameter.required) {
        required.push(parameter.name);
        warnings.push(`Path parameter "${parameter.name}" was not marked required; treating it as required.`);
      }
    } else if (parameter.in === 'query') {
      queryParams.push(parameter.name);
    } else {
      headerParams.push(parameter.name);
      if (/auth|key|token|secret/i.test(parameter.name)) {
        warnings.push(
          `Header "${parameter.name}" looks like a credential. Configure it server-side instead of exposing it as a tool parameter.`,
        );
      }
    }
  }

  const bodySchemaRaw =
    operation.requestBody?.content?.['application/json']?.schema ??
    Object.values(operation.requestBody?.content ?? {})[0]?.schema;
  const bodyProperties: string[] = [];
  let hasBody = false;

  if (bodySchemaRaw) {
    hasBody = true;
    const bodySchema = resolve(bodySchemaRaw, schemas);
    if (bodySchema.type === 'object' && bodySchema.properties) {
      // Flatten the body into the tool's own parameters: a caller should not
      // have to know which values travel in the body and which in the query.
      for (const [name, property] of Object.entries(bodySchema.properties)) {
        if (properties[name]) {
          warnings.push(`Body property "${name}" collides with a parameter of the same name.`);
          continue;
        }
        properties[name] = resolve(property, schemas);
        bodyProperties.push(name);
      }
      for (const name of bodySchema.required ?? []) {
        if (!required.includes(name)) {
          required.push(name);
        }
      }
    } else {
      properties.body = bodySchema;
      bodyProperties.push('body');
      if (operation.requestBody?.required) {
        required.push('body');
      }
      warnings.push('Request body is not an object schema; exposed as a single `body` parameter.');
    }
  }

  const name = uniqueName(operationName(operation, method, path), usedNames);
  const description =
    operation.summary ??
    operation.description ??
    `${method.toUpperCase()} ${path}`;
  if (!operation.summary && !operation.description) {
    warnings.push('Operation has no summary or description; a placeholder was generated.');
  }

  const responseSchemaRaw =
    operation.responses?.['200']?.content?.['application/json']?.schema ??
    operation.responses?.['201']?.content?.['application/json']?.schema;

  const tool: Tool = {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties,
      required: [...new Set(required)],
    },
    ...(responseSchemaRaw ? { outputSchema: resolve(responseSchemaRaw, schemas) } : {}),
    annotations: annotationsFor(method),
  };

  return {
    tool,
    binding: { method: method.toUpperCase(), path, pathParams, queryParams, headerParams, bodyProperties, hasBody },
    warnings,
  };
}

function annotationsFor(method: string): ToolAnnotations {
  switch (method) {
    case 'get':
      return { readOnlyHint: true };
    case 'delete':
      return { destructiveHint: true, idempotentHint: true };
    case 'put':
      return { idempotentHint: true };
    default:
      return {};
  }
}

function operationName(operation: OpenApiOperation, method: string, path: string): string {
  if (operation.operationId) {
    return camel(operation.operationId);
  }
  // getEventsById from GET /events/{id}
  const segments = path
    .split('/')
    .filter(Boolean)
    .map((segment) =>
      segment.startsWith('{') ? `By${pascal(segment.replace(/[{}]/g, ''))}` : pascal(segment),
    );
  return camel(`${method}${segments.join('')}`);
}

function uniqueName(name: string, used: Set<string>): string {
  let candidate = name;
  let counter = 2;
  while (used.has(candidate)) {
    candidate = `${name}${counter++}`;
  }
  used.add(candidate);
  return candidate;
}

/** Resolves `$ref` one level at a time; cycles stop at a permissive schema. */
function resolve(
  schema: JsonSchema,
  schemas: Record<string, JsonSchema>,
  depth = 0,
): JsonSchema {
  if (depth > 8) {
    return { type: 'object', description: 'Recursive schema truncated' };
  }

  const ref = (schema as { $ref?: string }).$ref;
  if (ref) {
    const name = ref.split('/').pop();
    const target = name ? schemas[name] : undefined;
    return target ? resolve(target, schemas, depth + 1) : { type: 'object' };
  }

  const resolved: JsonSchema = { ...schema };
  if (schema.properties) {
    resolved.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [
        key,
        resolve(value, schemas, depth + 1),
      ]),
    );
  }
  if (schema.items && !Array.isArray(schema.items)) {
    resolved.items = resolve(schema.items, schemas, depth + 1);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Code generation
// ---------------------------------------------------------------------------

/** TypeScript handlers that call the REST endpoints behind the generated tools. */
export function generateTypeScriptHandlers(
  generated: GeneratedTool[],
  baseUrl: string,
): string {
  const lines: string[] = [
    `import { z } from 'zod';`,
    `import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
    '',
    `const BASE_URL = process.env.API_BASE_URL ?? ${JSON.stringify(baseUrl)};`,
    '',
    '/**',
    ' * Generated from an OpenAPI document by MCP Workbench.',
    ' * Handlers are thin on purpose: add auth, retries and mapping where marked.',
    ' */',
    'export function registerGeneratedTools(server: McpServer): void {',
  ];

  for (const { tool, binding } of generated) {
    const properties = tool.inputSchema.properties ?? {};
    const requiredNames = new Set(tool.inputSchema.required ?? []);

    lines.push('  server.registerTool(');
    lines.push(`    ${JSON.stringify(tool.name)},`);
    lines.push('    {');
    lines.push(`      description: ${JSON.stringify(tool.description ?? '')},`);
    lines.push('      inputSchema: {');
    for (const [name, property] of Object.entries(properties)) {
      lines.push(
        `        ${safeKey(name)}: ${zodFor(property, requiredNames.has(name))},`,
      );
    }
    lines.push('      },');
    if (tool.annotations && Object.keys(tool.annotations).length > 0) {
      lines.push(`      annotations: ${JSON.stringify(tool.annotations)},`);
    }
    lines.push('    },');
    lines.push('    async (args) => {');

    // Path
    const pathExpression = binding.pathParams.reduce(
      (expression, name) =>
        expression.replace(`{${name}}`, `\${encodeURIComponent(String(args[${JSON.stringify(name)}]))}`),
      binding.path,
    );
    lines.push(`      const url = new URL(\`\${BASE_URL}${pathExpression}\`);`);

    if (binding.queryParams.length) {
      lines.push(`      for (const key of ${JSON.stringify(binding.queryParams)}) {`);
      lines.push('        const value = (args as Record<string, unknown>)[key];');
      lines.push('        if (value !== undefined && value !== null) {');
      lines.push('          url.searchParams.set(key, String(value));');
      lines.push('        }');
      lines.push('      }');
    }

    lines.push('      const response = await fetch(url, {');
    lines.push(`        method: ${JSON.stringify(binding.method)},`);
    lines.push("        headers: { accept: 'application/json'" +
      (binding.hasBody ? ", 'content-type': 'application/json'" : '') +
      ' /* TODO: add auth headers here */ },');
    if (binding.hasBody) {
      const bodyKeys = JSON.stringify(binding.bodyProperties);
      lines.push('        body: JSON.stringify(');
      lines.push(`          Object.fromEntries(`);
      lines.push(`            ${bodyKeys}`);
      lines.push('              .map((key) => [key, (args as Record<string, unknown>)[key]])');
      lines.push('              .filter(([, value]) => value !== undefined),');
      lines.push('          ),');
      lines.push('        ),');
    }
    lines.push('      });');
    lines.push('');
    lines.push('      if (!response.ok) {');
    lines.push('        // An MCP tool reports a failure in-band so the caller can react.');
    lines.push('        return {');
    lines.push('          isError: true,');
    lines.push(
      '          content: [{ type: \'text\', text: `HTTP ${response.status} ${response.statusText}` }],',
    );
    lines.push('        };');
    lines.push('      }');
    lines.push('');
    lines.push('      const payload = await response.json();');
    lines.push('      return {');
    lines.push("        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],");
    lines.push('        structuredContent: payload,');
    lines.push('      };');
    lines.push('    },');
    lines.push('  );');
    lines.push('');
  }

  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

function zodFor(schema: JsonSchema, required: boolean): string {
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  let base: string;

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    base = `z.enum(${JSON.stringify(schema.enum.map(String))} as [string, ...string[]])`;
  } else {
    switch (type) {
      case 'integer':
        base = 'z.number().int()';
        break;
      case 'number':
        base = 'z.number()';
        break;
      case 'boolean':
        base = 'z.boolean()';
        break;
      case 'array':
        base = 'z.array(z.unknown())';
        break;
      case 'object':
        base = 'z.record(z.unknown())';
        break;
      default:
        base = 'z.string()';
    }
  }

  if (schema.description) {
    base += `.describe(${JSON.stringify(schema.description)})`;
  }
  return required ? base : `${base}.optional()`;
}

function safeKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function camel(value: string): string {
  const pascalCase = pascal(value);
  return pascalCase.charAt(0).toLowerCase() + pascalCase.slice(1);
}

function pascal(value: string): string {
  return value
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}
