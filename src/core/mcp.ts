import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { ProviderError } from '../contracts';

/**
 * Minimal MCP stdio client.
 *
 * Existing MCP servers (Google Trends, competitor intel, ad platforms) are the
 * cheapest way to widen the monitoring layer — config instead of code. This
 * speaks just enough of the protocol to list and call tools: initialize,
 * notifications/initialized, tools/list, tools/call.
 *
 * The stdio transport is newline-delimited JSON-RPC 2.0.
 */

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Per-request timeout. */
  timeoutMs?: number;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface PendingCall {
  resolve: (value: any) => void;
  reject: (err: unknown) => void;
  timer: NodeJS.Timeout;
}

const PROTOCOL_VERSION = '2024-11-05';

export class McpClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private ready: Promise<void> | null = null;

  constructor(private readonly config: McpServerConfig) {}

  /** Start the server and complete the handshake. Idempotent. */
  async connect(): Promise<void> {
    if (this.ready) return this.ready;

    this.ready = (async () => {
      const proc = spawn(this.config.command, this.config.args ?? [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(this.config.cwd ? { cwd: this.config.cwd } : {}),
        env: { ...process.env, ...(this.config.env ?? {}) },
      });
      this.proc = proc;

      proc.on('error', (err) => {
        const message =
          (err as NodeJS.ErrnoException).code === 'ENOENT'
            ? `MCP server not found: ${this.config.command}`
            : err.message;
        this.failAll(new ProviderError(message, 'misconfigured', false, err));
      });

      proc.on('exit', (code) => {
        // A server that dies mid-request must not leave callers hanging.
        this.failAll(new ProviderError(`MCP server exited with code ${code}`, 'transient', true));
      });

      proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
      // stderr is where MCP servers log; it is not protocol traffic.
      proc.stderr.on('data', () => {});

      await this.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'mediabot', version: '0.0.1' },
      });
      this.notify('notifications/initialized');
    })();

    try {
      await this.ready;
    } catch (err) {
      // Allow a later retry rather than caching the failure forever.
      this.ready = null;
      throw err;
    }
  }

  async listTools(): Promise<McpTool[]> {
    await this.connect();
    const res = await this.request('tools/list', {});
    return Array.isArray(res?.tools) ? res.tools : [];
  }

  /** Call a tool and return its content blocks flattened to text. */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<string> {
    await this.connect();
    const res = await this.request('tools/call', { name, arguments: args });

    if (res?.isError) {
      throw new ProviderError(`MCP tool "${name}" reported an error: ${textOf(res)}`, 'unknown', false);
    }
    return textOf(res);
  }

  close(): void {
    this.failAll(new ProviderError('MCP client closed', 'unknown', false));
    this.proc?.kill('SIGTERM');
    this.proc = null;
    this.ready = null;
  }

  private request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    const timeoutMs = this.config.timeoutMs ?? 60_000;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ProviderError(`MCP request "${method}" timed out`, 'transient', true));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  private write(message: unknown): void {
    if (!this.proc) throw new ProviderError('MCP client is not connected', 'misconfigured', false);
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString();
    const lines = this.buffer.split('\n');
    // Keep the trailing partial line until its newline arrives.
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let msg: any;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue; // Servers sometimes print non-protocol noise to stdout.
      }
      if (typeof msg?.id !== 'number') continue; // Notification, not a reply.

      const pending = this.pending.get(msg.id);
      if (!pending) continue;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);

      if (msg.error) {
        pending.reject(
          new ProviderError(`MCP error ${msg.error.code}: ${msg.error.message}`, 'unknown', false),
        );
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  private failAll(err: unknown): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}

/** Flatten MCP content blocks into a single string. */
export function textOf(result: any): string {
  const content = result?.content;
  if (!Array.isArray(content)) return typeof result === 'string' ? result : JSON.stringify(result ?? '');
  return content
    .map((b: any) => (b?.type === 'text' ? b.text : JSON.stringify(b)))
    .join('\n')
    .trim();
}
