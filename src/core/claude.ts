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
 * Returns the shortest block, which is right for prose but wrong when the block
 * itself contains fences — see `parseFencedJson`, which callers should prefer
 * for structured output.
 */
export function extractFencedBlock(text: string, tag = 'json'): string | null {
  const candidates = fencedCandidates(text, tag);
  return candidates.length ? candidates[0]! : null;
}

/**
 * Parse a fenced JSON block, returning null instead of throwing.
 *
 * A naive "first opening fence to first closing fence" match breaks the moment
 * the JSON *contains* a fence — and it does, constantly: any draft for a
 * technical blog carries ```bash blocks inside its body string. So each
 * possible closing fence is tried in turn and the first one that parses wins.
 * Only the true end of the block yields valid JSON, which makes the parse
 * itself the disambiguator.
 */
export function parseFencedJson<T = unknown>(text: string, tag = 'json'): T | null {
  for (const candidate of fencedCandidates(text, tag)) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // This closing fence was inside the payload; try the next one.
    }
  }
  return null;
}

/**
 * Every plausible block body, shortest first: the text between the opening
 * fence and each subsequent closing fence.
 */
function fencedCandidates(text: string, tag: string): string[] {
  const open = findOpeningFence(text, tag);
  if (open === null) return [];

  const out: string[] = [];
  const closing = /```/g;
  closing.lastIndex = open;

  let m: RegExpExecArray | null;
  while ((m = closing.exec(text)) !== null) {
    const body = text.slice(open, m.index).trim();
    if (body) out.push(body);
  }
  return out;
}

/** Index just past the opening fence, preferring the tagged form. */
function findOpeningFence(text: string, tag: string): number | null {
  const tagged = new RegExp('```' + tag + '[^\\S\\n]*\\n', 'i').exec(text);
  if (tagged) return tagged.index + tagged[0].length;

  // Models sometimes omit the tag; fall back to a bare fence.
  const bare = /```[^\S\n]*\n/.exec(text);
  return bare ? bare.index + bare[0].length : null;
}
