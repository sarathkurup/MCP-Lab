import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { JsonRpcMessage } from '../protocol';
import { TransportError, type Transport } from './Transport';

export interface StdioTransportOptions {
  command: string;
  args?: string[];
  cwd?: string;
  /** Extra environment on top of the inherited one. */
  env?: Record<string, string>;
  /** When false, the child only sees `env`. Defaults to true. */
  inheritEnv?: boolean;
}

/**
 * Newline-delimited JSON over a child process's stdin/stdout, per the MCP stdio
 * transport. stdout carries protocol only; stderr is surfaced as logs.
 */
export class StdioTransport implements Transport {
  readonly kind = 'stdio';

  onMessage?: (message: JsonRpcMessage) => void;
  onError?: (error: Error) => void;
  onClose?: (reason?: string) => void;
  onStderr?: (chunk: string) => void;

  private child?: ChildProcessWithoutNullStreams;
  private stdoutBuffer = '';
  private closing = false;

  constructor(private readonly options: StdioTransportOptions) {}

  async start(): Promise<void> {
    if (this.child) throw new TransportError('Transport already started');

    const env = this.options.inheritEnv === false
      ? { ...(this.options.env ?? {}) }
      : { ...process.env, ...(this.options.env ?? {}) };

    return new Promise<void>((resolve, reject) => {
      const spawnSpec = resolveSpawn(this.options.command, this.options.args ?? []);
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(spawnSpec.command, spawnSpec.args, {
          cwd: this.options.cwd,
          env: env as NodeJS.ProcessEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: spawnSpec.shell,
        });
      } catch (err) {
        reject(new TransportError(`Failed to spawn "${this.options.command}"`, err));
        return;
      }

      this.child = child;
      let settled = false;

      child.on('error', (err) => {
        const error = new TransportError(`Process error: ${err.message}`, err);
        if (!settled) {
          settled = true;
          reject(error);
          return;
        }
        this.onError?.(error);
      });

      child.on('spawn', () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      child.on('exit', (code, signal) => {
        const reason = signal ? `killed by ${signal}` : `exited with code ${code ?? 'null'}`;
        if (!settled) {
          settled = true;
          reject(new TransportError(`Server process ${reason} before it was ready`));
          return;
        }
        if (!this.closing) this.onClose?.(`Server process ${reason}`);
      });

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => this.consume(chunk));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => this.onStderr?.(chunk));
    });
  }

  private consume(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, '');
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.trim().length > 0) {
        try {
          this.onMessage?.(JSON.parse(line) as JsonRpcMessage);
        } catch (err) {
          // Servers that print to stdout break the protocol; say so rather than dying.
          this.onError?.(
            new TransportError(`Non-JSON line on stdout: ${truncate(line)}`, err),
          );
        }
      }
      newline = this.stdoutBuffer.indexOf('\n');
    }
  }

  async send(message: JsonRpcMessage): Promise<void> {
    const child = this.child;
    if (!child || child.stdin.destroyed) {
      throw new TransportError('Transport is not connected');
    }
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(JSON.stringify(message) + '\n', (err) =>
        err ? reject(new TransportError('Failed to write to server stdin', err)) : resolve(),
      );
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.closing = true;
    this.child = undefined;

    await new Promise<void>((resolve) => {
      const done = () => resolve();
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 2000);
      child.once('exit', () => {
        clearTimeout(timer);
        done();
      });
      child.stdin.end();
      child.kill();
    });
  }
}

function truncate(value: string, max = 200): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * Windows needs a shell to run `npx`/`npm` style launchers, because Node refuses
 * to exec a .cmd directly. But a shell also re-parses the command line, so a path
 * with spaces has to be quoted. A command that already looks like a path is run
 * without a shell, which keeps arguments byte-for-byte intact.
 */
export function resolveSpawn(
  command: string,
  args: string[],
): { command: string; args: string[]; shell: boolean } {
  const looksLikePath = /[\\/]/.test(command);
  const shell = process.platform === 'win32' && !looksLikePath;
  if (!shell) {
    return { command, args, shell: false };
  }
  return {
    command: quoteForShell(command),
    args: args.map(quoteForShell),
    shell: true,
  };
}

function quoteForShell(value: string): string {
  if (value.length > 0 && !/[\s"^&|<>()%!]/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '\\"')}"`;
}
