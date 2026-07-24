import { execFile } from 'child_process';
import { ProviderError } from '../contracts';

/**
 * Runs an external CLI tool as a subprocess.
 *
 * This is the integration mode that carries most of MediaBot's platform reach:
 * wrapping a binary rather than vendoring its source. Beyond being far less
 * code, invoking a program does not create a derivative work, so this route
 * stays licence-clean even for upstreams whose source we could not copy.
 *
 * Every provider that shells out goes through here so timeouts, argument
 * handling and error classification are uniform.
 */

export interface CliRunOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Bytes of stdout to accept; guards against a runaway tool. */
  maxBuffer?: number;
}

export interface CliResult {
  stdout: string;
  stderr: string;
}

/** The subprocess runner, injectable so providers stay testable offline. */
export type CliRunner = (bin: string, args: string[], opts?: CliRunOptions) => Promise<CliResult>;

export const defaultCliRunner: CliRunner = (bin, args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.env ? { env: opts.env } : {}),
      },
      (err, stdout, stderr) => {
        if (!err) return resolve({ stdout: String(stdout), stderr: String(stderr) });

        const e = err as NodeJS.ErrnoException & { killed?: boolean };
        if (e.code === 'ENOENT') {
          return reject(
            new ProviderError(
              `command not found: ${bin} — install it or point the provider at the right path`,
              'misconfigured',
              false,
              err,
            ),
          );
        }
        if (e.killed) {
          return reject(new ProviderError(`${bin} timed out`, 'transient', true, err));
        }
        return reject(
          new ProviderError(
            `${bin} exited with an error: ${String(stderr).trim() || err.message}`,
            classify(`${stdout}\n${stderr}`),
            false,
            err,
          ),
        );
      },
    );
  });

/**
 * Map tool output onto the error codes the daemon acts on.
 *
 * Auth failures must not be retried (they need a human to re-login) while rate
 * limits and 5xx should back off and try again.
 */
function classify(output: string): 'auth_expired' | 'rate_limited' | 'transient' | 'rejected' | 'unknown' {
  const s = output.toLowerCase();
  if (/not logged in|unauthor|401|403|login required|cookie.*(expired|invalid)|请先登录/.test(s)) {
    return 'auth_expired';
  }
  if (/rate.?limit|429|too many requests|频繁/.test(s)) return 'rate_limited';
  if (/timeout|econn|network|502|503|504/.test(s)) return 'transient';
  if (/invalid|rejected|not allowed|违规|审核/.test(s)) return 'rejected';
  return 'unknown';
}

/**
 * Run a CLI that emits JSON and parse its stdout.
 *
 * Tools routinely print progress lines before the payload, so the first `{` or
 * `[` is located rather than parsing the whole stream.
 */
export async function runJsonCli<T = unknown>(
  runner: CliRunner,
  bin: string,
  args: string[],
  opts: CliRunOptions = {},
): Promise<T> {
  const { stdout } = await runner(bin, args, opts);
  const start = stdout.search(/[[{]/);
  if (start < 0) {
    throw new ProviderError(`${bin} produced no JSON output`, 'unknown', false);
  }
  try {
    return JSON.parse(stdout.slice(start)) as T;
  } catch (err) {
    throw new ProviderError(`${bin} produced malformed JSON`, 'unknown', false, err);
  }
}
