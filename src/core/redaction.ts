/**
 * Redaction for anything McpLab displays or persists.
 *
 * Logs, history and traces all outlive the moment they were produced: they are
 * copied into issues, pasted into chats and fed to models. A token that reaches
 * them has effectively leaked, so it is masked on the way in rather than on the
 * way out.
 */

interface Rule {
  name: string;
  pattern: RegExp;
  /** Replacement, which may use capture groups to keep surrounding context. */
  replace: (match: string, ...groups: string[]) => string;
}

const MASK = '***redacted***';

const RULES: Rule[] = [
  {
    name: 'authorization header',
    pattern: /\b(authorization\s*[:=]\s*)(bearer\s+)?([A-Za-z0-9._~+/-]{12,}=*)/gi,
    replace: (_match, prefix, scheme) => `${prefix}${scheme ?? ''}${MASK}`,
  },
  {
    name: 'bearer token',
    pattern: /\b(Bearer\s+)([A-Za-z0-9._~+/-]{12,}=*)/g,
    replace: (_match, prefix) => `${prefix}${MASK}`,
  },
  {
    name: 'assignment to a secret-looking key',
    pattern:
      /\b(password|passwd|secret|api[_-]?key|apikey|token|access[_-]?token|client[_-]?secret|credential)(["']?\s*[:=]\s*["']?)([^\s"',}]{6,})/gi,
    replace: (_match, key, separator) => `${key}${separator}${MASK}`,
  },
  {
    name: 'AWS access key id',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replace: () => MASK,
  },
  {
    name: 'GitHub token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    replace: () => MASK,
  },
  {
    name: 'Slack token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    replace: () => MASK,
  },
  {
    name: 'JSON Web Token',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replace: () => MASK,
  },
  {
    name: 'private key block',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END [^-]+-----/g,
    replace: () => `-----BEGIN PRIVATE KEY----- ${MASK} -----END PRIVATE KEY-----`,
  },
];

/** Masks credentials in a string. Returns the input unchanged when clean. */
export function redact(text: string): string {
  if (!text) {
    return text;
  }
  let output = text;
  for (const rule of RULES) {
    // Reset lastIndex: these regexes are global and reused across calls.
    rule.pattern.lastIndex = 0;
    output = output.replace(rule.pattern, rule.replace as (...args: string[]) => string);
  }
  return output;
}

/** Masks credentials anywhere inside a structure, keeping its shape. */
export function redactValue<T>(value: T, depth = 0): T {
  if (depth > 8 || value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return redact(value) as unknown as T;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, depth + 1)) as unknown as T;
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      // A field named like a credential is masked whatever its value looks like.
      if (/^(password|passwd|secret|api[_-]?key|apikey|token|access[_-]?token|client[_-]?secret|credential|authorization)$/i.test(key)) {
        out[key] = typeof entry === 'string' ? MASK : entry;
        continue;
      }
      out[key] = redactValue(entry, depth + 1);
    }
    return out as unknown as T;
  }

  return value;
}

/** True when the text contains something that would be masked. */
export function containsSecret(text: string): boolean {
  return redact(text) !== text;
}
