/**
 * Minimal cron matcher and tick loop.
 *
 * A dependency-free 5-field cron is enough for "poll at 08:00 on weekdays" and
 * keeps the plugin ABI's dependency surface small. Supports `*`, `N`, `a,b`,
 * `a-b` and `*_/N` steps.
 */

export interface CronFields {
  minute: string;
  hour: string;
  dayOfMonth: string;
  month: string;
  dayOfWeek: string;
}

export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron must have 5 fields, got ${parts.length}: "${expr}"`);
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [string, string, string, string, string];
  const fields = { minute, hour, dayOfMonth, month, dayOfWeek };
  // Validate eagerly so a bad expression fails at config time, not at 3am.
  matchField(fields.minute, 0, 0, 59);
  matchField(fields.hour, 0, 0, 23);
  matchField(fields.dayOfMonth, 1, 1, 31);
  matchField(fields.month, 1, 1, 12);
  matchField(fields.dayOfWeek, 0, 0, 6);
  return fields;
}

/** Does `date` fall on this cron's schedule (to the minute)? */
export function cronMatches(expr: string, date: Date): boolean {
  const f = parseCron(expr);
  return (
    matchField(f.minute, date.getMinutes(), 0, 59) &&
    matchField(f.hour, date.getHours(), 0, 23) &&
    matchField(f.dayOfMonth, date.getDate(), 1, 31) &&
    matchField(f.month, date.getMonth() + 1, 1, 12) &&
    matchField(f.dayOfWeek, date.getDay(), 0, 6)
  );
}

function matchField(field: string, value: number, min: number, max: number): boolean {
  for (const part of field.split(',')) {
    if (matchPart(part.trim(), value, min, max)) return true;
  }
  return false;
}

function matchPart(part: string, value: number, min: number, max: number): boolean {
  const [range, stepText] = part.split('/');
  const step = stepText === undefined ? 1 : Number(stepText);
  if (!Number.isInteger(step) || step < 1) throw new Error(`bad cron step: "${part}"`);

  let lo: number;
  let hi: number;
  if (range === '*' || range === undefined) {
    lo = min;
    hi = max;
  } else if (range.includes('-')) {
    const [a, b] = range.split('-').map(Number);
    if (!Number.isInteger(a) || !Number.isInteger(b)) throw new Error(`bad cron range: "${part}"`);
    lo = a!;
    hi = b!;
  } else {
    const n = Number(range);
    if (!Number.isInteger(n)) throw new Error(`bad cron value: "${part}"`);
    lo = n;
    hi = n;
  }

  if (lo < min || hi > max || lo > hi) throw new Error(`cron value out of range: "${part}"`);
  if (value < lo || value > hi) return false;
  return (value - lo) % step === 0;
}

export interface ScheduledJob {
  name: string;
  cron: string;
  run: () => Promise<void>;
}

export interface SchedulerOptions {
  /** How often to evaluate the schedule. */
  tickMs?: number;
  now?: () => Date;
  onError?: (job: string, err: unknown) => void;
}

/**
 * Fires jobs whose cron matches the current minute.
 *
 * Each minute fires at most once per job even if the tick runs more often, and
 * a job that is still running is never started concurrently with itself — a
 * slow publish must not stack up behind a fast tick.
 */
export class Scheduler {
  private readonly jobs: ScheduledJob[] = [];
  private readonly lastFired = new Map<string, string>();
  private readonly running = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: SchedulerOptions = {}) {}

  add(job: ScheduledJob): this {
    parseCron(job.cron);
    this.jobs.push(job);
    return this;
  }

  /** Evaluate every job once against the current time. */
  async tick(): Promise<void> {
    const now = (this.opts.now ?? (() => new Date()))();
    const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}T${now.getHours()}:${now.getMinutes()}`;

    for (const job of this.jobs) {
      if (this.lastFired.get(job.name) === minuteKey) continue;
      if (!cronMatches(job.cron, now)) continue;
      if (this.running.has(job.name)) continue;

      this.lastFired.set(job.name, minuteKey);
      this.running.add(job.name);
      try {
        await job.run();
      } catch (err) {
        // One failing job must never stop the scheduler.
        this.opts.onError?.(job.name, err);
      } finally {
        this.running.delete(job.name);
      }
    }
  }

  start(): void {
    if (this.timer) return;
    const tickMs = this.opts.tickMs ?? 30_000;
    this.timer = setInterval(() => {
      void this.tick();
    }, tickMs);
    // Do not hold the process open on this timer alone.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get jobNames(): string[] {
    return this.jobs.map((j) => j.name);
  }
}
