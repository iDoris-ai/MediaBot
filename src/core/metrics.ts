import { defaultCliRunner, runJsonCli, type CliRunner } from './cli-adapter';
import type { Db } from './db';

/**
 * Metric collection for the goal layer.
 *
 * A collector returns `null` when a platform genuinely cannot report a metric.
 * That distinction matters more than it looks: a goal may not be activated
 * without a *measured* baseline, so a fabricated or defaulted zero would let
 * someone set a target against a number that was never real, and every later
 * review would compare against fiction.
 */

export interface MetricReading {
  metric: string;
  value: number | null;
  /** Why the value is null, when it is. */
  unavailable?: string;
  measuredAt: number;
}

export interface MetricCollector {
  /** Namespaced, e.g. "twitter.followers". */
  readonly metric: string;
  readonly description: string;
  collect(): Promise<MetricReading>;
}

export interface CliMetricOptions {
  bin?: string;
  runner?: CliRunner;
  timeoutMs?: number;
  now?: () => number;
}

/** Reads a numeric field out of `<tool> whoami --json`. */
class WhoamiMetric implements MetricCollector {
  constructor(
    readonly metric: string,
    readonly description: string,
    private readonly defaultBin: string,
    private readonly envBin: string,
    private readonly pick: (data: any) => unknown,
    private readonly opts: CliMetricOptions = {},
  ) {}

  async collect(): Promise<MetricReading> {
    const now = (this.opts.now ?? Date.now)();
    const bin = this.opts.bin ?? process.env[this.envBin] ?? this.defaultBin;
    const runner = this.opts.runner ?? defaultCliRunner;

    try {
      const res = await runJsonCli<any>(runner, bin, ['whoami', '--json'], {
        timeoutMs: this.opts.timeoutMs ?? 30_000,
      });
      const raw = this.pick(res?.data ?? res);
      const value = typeof raw === 'number' ? raw : Number(raw);

      if (!Number.isFinite(value)) {
        return {
          metric: this.metric,
          value: null,
          unavailable: `${bin} whoami did not report ${this.metric}`,
          measuredAt: now,
        };
      }
      return { metric: this.metric, value, measuredAt: now };
    } catch (err) {
      return {
        metric: this.metric,
        value: null,
        unavailable: err instanceof Error ? err.message : String(err),
        measuredAt: now,
      };
    }
  }
}

export function buildCollectors(opts: CliMetricOptions = {}): MetricCollector[] {
  return [
    new WhoamiMetric(
      'twitter.followers',
      'X/Twitter follower count',
      'twitter',
      'TWITTER_BIN',
      (d) => d?.user?.followers ?? d?.followers,
      opts,
    ),
    new WhoamiMetric(
      'twitter.posts',
      'X/Twitter lifetime post count',
      'twitter',
      'TWITTER_BIN',
      (d) => d?.user?.tweets ?? d?.tweets,
      opts,
    ),
  ];
}

/**
 * Metrics MediaBot computes from its own database rather than a platform.
 *
 * These are always available, which makes them a usable fallback baseline when
 * no platform exposes an audience number.
 */
export function localCollectors(db: Db, now: () => number = Date.now): MetricCollector[] {
  const count = (metric: string, description: string, sql: string): MetricCollector => ({
    metric,
    description,
    collect: async () => ({
      metric,
      value: (db.prepare(sql).get() as any).c as number,
      measuredAt: now(),
    }),
  });

  return [
    count('mediabot.published', 'Posts published by MediaBot', `SELECT COUNT(*) c FROM posts WHERE state='published'`),
    count('mediabot.replies', 'Replies sent by MediaBot', `SELECT COUNT(*) c FROM comments WHERE state='replied'`),
    count('mediabot.signals', 'Monitoring signals collected', `SELECT COUNT(*) c FROM source_items`),
  ];
}

/** Collect one metric by id, or null if no collector provides it. */
export async function collectMetric(
  collectors: MetricCollector[],
  metric: string,
): Promise<MetricReading | null> {
  const c = collectors.find((x) => x.metric === metric);
  return c ? c.collect() : null;
}
