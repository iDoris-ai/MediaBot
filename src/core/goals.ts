import type { Db } from './db';
import { newId } from './identity';
import { collectMetric, type MetricCollector } from './metrics';

/**
 * The goal layer.
 *
 * A goal is not a config value — it is a commitment with a measured baseline, a
 * target, a deadline, and a review cadence. The rule that gives the rest its
 * meaning: a goal cannot be activated without a real measurement. Without that,
 * "grow followers 30%" is 30% of a number nobody ever checked, and every later
 * review compares against fiction.
 *
 * Each review also records what the previous review *predicted*, so the agent's
 * judgement can be scored over time rather than taken on faith.
 */

export type GoalState = 'draft' | 'active' | 'paused' | 'done' | 'failed';

export interface Goal {
  id: string;
  title: string;
  metric: string;
  baseline: number | null;
  baselineMeasuredAt: number | null;
  target: number | null;
  deadline: number | null;
  cadence: string | null;
  state: GoalState;
  createdAt: number;
  updatedAt: number;
}

export interface GoalCheck {
  id: string;
  goalId: string;
  measured: number | null;
  /** What the previous check predicted this one would read. */
  predicted: number | null;
  note: string | null;
  checkedAt: number;
}

export interface GoalProgress {
  goal: Goal;
  latest: number | null;
  /** 0..1, or null when the baseline or target is missing. */
  progress: number | null;
  /** Accuracy of the last prediction as a fraction, null if none to score. */
  lastPredictionError: number | null;
  checks: GoalCheck[];
}

export class GoalStore {
  constructor(
    private readonly db: Db,
    private readonly collectors: MetricCollector[],
    private readonly now: () => number = Date.now,
  ) {}

  /** Create a goal in draft. It cannot be acted on until measured and activated. */
  propose(input: {
    title: string;
    metric: string;
    target?: number;
    deadline?: Date;
    cadence?: string;
  }): Goal {
    const id = newId('goal');
    const ts = this.now();
    this.db
      .prepare(
        `INSERT INTO goals (id, title, metric, target, deadline, cadence, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
      )
      .run(
        id,
        input.title,
        input.metric,
        input.target ?? null,
        input.deadline ? input.deadline.getTime() : null,
        input.cadence ?? '0 9 * * 1',
        ts,
        ts,
      );
    return this.get(id)!;
  }

  /** Measure the goal's metric now and store it as the baseline. */
  async measureBaseline(goalId: string): Promise<{ goal: Goal; error?: string }> {
    const goal = this.require(goalId);
    const reading = await collectMetric(this.collectors, goal.metric);

    if (!reading) {
      return { goal, error: `no collector provides "${goal.metric}"` };
    }
    if (reading.value === null) {
      return { goal, error: reading.unavailable ?? 'metric unavailable' };
    }

    this.db
      .prepare(`UPDATE goals SET baseline = ?, baseline_measured_at = ?, updated_at = ? WHERE id = ?`)
      .run(reading.value, reading.measuredAt, this.now(), goalId);
    return { goal: this.get(goalId)! };
  }

  /**
   * Activate a goal.
   *
   * Refuses without a measured baseline and a target — the two things that make
   * later reviews mean anything.
   */
  activate(goalId: string): Goal {
    const goal = this.require(goalId);
    if (goal.baseline === null) {
      throw new Error(
        `goal ${goalId} has no measured baseline — run measureBaseline first; a target set against an unmeasured number cannot be reviewed honestly`,
      );
    }
    if (goal.target === null) {
      throw new Error(`goal ${goalId} has no target`);
    }
    this.db
      .prepare(`UPDATE goals SET state = 'active', updated_at = ? WHERE id = ?`)
      .run(this.now(), goalId);
    return this.get(goalId)!;
  }

  /**
   * Take a reading, score the previous prediction, and record a new one.
   *
   * `predictNext` is what the caller expects the metric to read at the next
   * check; storing it makes the agent's forecasting auditable instead of a
   * claim nobody revisits.
   */
  async review(
    goalId: string,
    opts: { note?: string; predictNext?: number } = {},
  ): Promise<GoalCheck> {
    const goal = this.require(goalId);
    const reading = await collectMetric(this.collectors, goal.metric);
    const measured = reading?.value ?? null;

    const previous = this.db
      .prepare(`SELECT predicted FROM goal_checks WHERE goal_id = ? ORDER BY checked_at DESC LIMIT 1`)
      .get(goalId) as any;

    const id = newId('check');
    const checkedAt = this.now();
    this.db
      .prepare(
        `INSERT INTO goal_checks (id, goal_id, measured, predicted, note, checked_at) VALUES (?,?,?,?,?,?)`,
      )
      .run(
        id,
        goalId,
        measured,
        // Store this round's forecast; the previous round's is scored below.
        opts.predictNext ?? null,
        opts.note ?? reading?.unavailable ?? null,
        checkedAt,
      );

    if (measured !== null && goal.target !== null) {
      const reachedUp = goal.baseline !== null && goal.target >= goal.baseline && measured >= goal.target;
      const reachedDown = goal.baseline !== null && goal.target < goal.baseline && measured <= goal.target;
      if (reachedUp || reachedDown) {
        this.setState(goalId, 'done');
      } else if (goal.deadline !== null && checkedAt > goal.deadline) {
        this.setState(goalId, 'failed');
      }
    }

    void previous;
    return this.getCheck(id)!;
  }

  progress(goalId: string): GoalProgress {
    const goal = this.require(goalId);
    const checks = (
      this.db
        .prepare(`SELECT * FROM goal_checks WHERE goal_id = ? ORDER BY checked_at DESC`)
        .all(goalId) as any[]
    ).map(hydrateCheck);

    const latest = checks.find((c) => c.measured !== null)?.measured ?? null;

    let progress: number | null = null;
    if (latest !== null && goal.baseline !== null && goal.target !== null && goal.target !== goal.baseline) {
      progress = (latest - goal.baseline) / (goal.target - goal.baseline);
    }

    // Score the most recent prediction against the reading that followed it.
    let lastPredictionError: number | null = null;
    for (let i = 0; i < checks.length - 1; i += 1) {
      const actual = checks[i]!.measured;
      const forecast = checks[i + 1]!.predicted;
      if (actual !== null && forecast !== null && actual !== 0) {
        lastPredictionError = Math.abs(actual - forecast) / Math.abs(actual);
        break;
      }
    }

    return { goal, latest, progress, lastPredictionError, checks };
  }

  /** Active goals whose cadence says they are due (matched by the caller's cron). */
  listActive(): Goal[] {
    return (this.db.prepare(`SELECT * FROM goals WHERE state = 'active'`).all() as any[]).map(hydrate);
  }

  list(state?: GoalState): Goal[] {
    const rows = state
      ? this.db.prepare(`SELECT * FROM goals WHERE state = ? ORDER BY created_at DESC`).all(state)
      : this.db.prepare(`SELECT * FROM goals ORDER BY created_at DESC`).all();
    return (rows as any[]).map(hydrate);
  }

  get(id: string): Goal | undefined {
    const row = this.db.prepare(`SELECT * FROM goals WHERE id = ?`).get(id) as any;
    return row ? hydrate(row) : undefined;
  }

  getCheck(id: string): GoalCheck | undefined {
    const row = this.db.prepare(`SELECT * FROM goal_checks WHERE id = ?`).get(id) as any;
    return row ? hydrateCheck(row) : undefined;
  }

  setState(id: string, state: GoalState): Goal {
    this.db.prepare(`UPDATE goals SET state = ?, updated_at = ? WHERE id = ?`).run(state, this.now(), id);
    return this.get(id)!;
  }

  private require(id: string): Goal {
    const g = this.get(id);
    if (!g) throw new Error(`goal ${id} not found`);
    return g;
  }
}

function hydrate(row: any): Goal {
  return {
    id: row.id,
    title: row.title,
    metric: row.metric,
    baseline: row.baseline,
    baselineMeasuredAt: row.baseline_measured_at,
    target: row.target,
    deadline: row.deadline,
    cadence: row.cadence,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function hydrateCheck(row: any): GoalCheck {
  return {
    id: row.id,
    goalId: row.goal_id,
    measured: row.measured,
    predicted: row.predicted,
    note: row.note,
    checkedAt: row.checked_at,
  };
}
