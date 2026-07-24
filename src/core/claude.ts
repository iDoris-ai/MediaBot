import { spawn } from 'child_process';

/**
 * Runs Claude Code as a subprocess and parses its JSONL event stream.
 *
 * MediaBot does not embed a model client. Every "thinking" step shells out to
 * the `claude` CLI, which means it rides the user's existing Claude Code login
 * (no separate API key) and can be pointed at Kimi / GLM / DeepSeek by setting
 * ANTHROPIC_BASE_URL in the environment.
 */

export interface ClaudeOptions {
  /** Working directory for the run. */
  cwd?: string;
  /** Overrides CLAUDE_MODEL. */
  model?: string;
  /** Extra directories the run may read. */
  addDirs?: string[];
  /** Hard timeout; the subprocess is killed when it elapses. */
  timeoutMs?: number;
  /** Cooperative cancellation. */
  signal?: AbortSignal;
  /** Streamed text/tool events, for progress display. */
  onEvent?: (ev: ClaudeEvent) => void;
}

export interface ClaudeEvent {
  type: 'session' | 'text' | 'tool' | 'result';
  text?: string;
  toolName?: string;
  sessionId?: string;
  costUsd?: number;
}

export interface ClaudeResult {
  /** Final `result` summary text from the CLI. */
  text: string;
  /** Concatenated assistant text blocks — use when `text` is empty. */
  transcript: string;
  sessionId: string;
  costUsd: number;
}

export class ClaudeError extends Error {
  constructor(message: string, readonly exitCode: number | null, readonly stderr: string) {
    super(message);
    this.name = 'ClaudeError';
  }
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export function claudeBin(): string {
  return process.env.CLAUDE_BIN || 'claude';
}

export function claudeModel(): string | undefined {
  return process.env.CLAUDE_MODEL || undefined;
}

/** Run a one-shot prompt and resolve with the final result. */
export function runClaude(prompt: string, opts: ClaudeOptions = {}): Promise<ClaudeResult> {
  return new Promise((resolve, reject) => {
    const args = ['--print', prompt, '--output-format', 'stream-json', '--verbose'];

    const model = opts.model ?? claudeModel();
    if (model) args.push('--model', model);
    for (const d of opts.addDirs ?? []) args.push('--add-dir', d);

    const proc = spawn(claudeBin(), args, {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(opts.signal ? { signal: opts.signal } : {}),
    });

    let stdoutBuf = '';
    let stderr = '';
    let transcript = '';
    let resultText = '';
    let sessionId = '';
    let costUsd = 0;
    let settled = false;

    // The CLI can run for minutes; without our own timer a hung process would
    // wedge the daemon's scheduler indefinitely.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGTERM');
      reject(new ClaudeError(`claude timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`, null, stderr));
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split('\n');
      // Keep the trailing partial line in the buffer until its newline arrives.
      stdoutBuf = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const msg = (err as NodeJS.ErrnoException).code === 'ENOENT'
        ? `claude CLI not found (looked for "${claudeBin()}"). Install Claude Code or set CLAUDE_BIN.`
        : err.message;
      reject(new ClaudeError(msg, null, stderr));
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stdoutBuf.trim()) handleLine(stdoutBuf);

      if (code !== 0) {
        // Surface the model's own error text when it produced one — it is far
        // more actionable than "exit code 1".
        const detail = resultText || stderr.trim() || `exit code ${code}`;
        reject(new ClaudeError(`claude failed: ${detail}`, code, stderr));
        return;
      }
      resolve({ text: resultText || transcript, transcript, sessionId, costUsd });
    });

    function handleLine(line: string): void {
      const trimmed = line.trim();
      if (!trimmed) return;
      let ev: any;
      try {
        ev = JSON.parse(trimmed);
      } catch {
        return; // Non-JSON debug output from the CLI — ignore.
      }

      if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
        sessionId = ev.session_id;
        opts.onEvent?.({ type: 'session', sessionId });
        return;
      }

      if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
        for (const block of ev.message.content) {
          if (block.type === 'text' && block.text) {
            transcript += block.text;
            opts.onEvent?.({ type: 'text', text: block.text });
          } else if (block.type === 'tool_use' && block.name) {
            opts.onEvent?.({ type: 'tool', toolName: block.name });
          }
        }
        return;
      }

      if (ev.type === 'result') {
        if (typeof ev.result === 'string') resultText = ev.result;
        if (typeof ev.total_cost_usd === 'number') costUsd = ev.total_cost_usd;
        else if (typeof ev.cost_usd === 'number') costUsd = ev.cost_usd;
        if (ev.session_id) sessionId = ev.session_id;
        opts.onEvent?.({ type: 'result', text: resultText, sessionId, costUsd });
      }
    }
  });
}

/**
 * Extract the first fenced code block with the given tag from model output.
 *
 * Composers ask Claude for a ```json block; models routinely wrap it in prose,
 * so callers must never JSON.parse the raw output directly.
 */
export function extractFencedBlock(text: string, tag = 'json'): string | null {
  const fence = new RegExp('```' + tag + '\\s*\\n([\\s\\S]*?)```', 'i');
  const m = fence.exec(text);
  if (m && m[1] !== undefined) return m[1].trim();

  // Fall back to a bare ``` block, which models emit when the tag is omitted.
  const bare = /```\s*\n([\s\S]*?)```/.exec(text);
  return bare && bare[1] !== undefined ? bare[1].trim() : null;
}

/** Parse a fenced JSON block, returning null instead of throwing. */
export function parseFencedJson<T = unknown>(text: string, tag = 'json'): T | null {
  const block = extractFencedBlock(text, tag);
  if (block === null) return null;
  try {
    return JSON.parse(block) as T;
  } catch {
    return null;
  }
}
