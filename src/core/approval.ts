import type { Consequence } from '../contracts';
import { grantCandidate, ruleParts, StandingRules, type GrantContext } from './consequence';
import type { Db } from './db';
import { newId, payloadHash } from './identity';

/**
 * The approval gate.
 *
 * Every outbound action — publishing a post, replying to a comment — passes
 * through here. This is deliberately the single choke point in the system: as
 * more capabilities get plugged in, the blast radius of a misbehaving provider
 * stays bounded by this one table.
 *
 * The payload is snapshotted with its hash at enqueue time and re-verified
 * immediately before execution, so what runs is exactly what a human saw and
 * approved. If anything changed in between, execution is refused and the item
 * goes back for re-approval rather than silently publishing something else.
 */

export type ApprovalKind = 'publish' | 'reply';
export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'expired';

export interface Approval {
  id: string;
  kind: ApprovalKind;
  refId: string;
  state: ApprovalState;
  payload: unknown;
  payloadHash: string;
  scheduledFor: number | null;
  decidedBy: string | null;
  decidedAt: number | null;
  reason: string | null;
  /**
   * The standing-rule entry this action is eligible for, if any. Present on
   * items nobody has granted yet — that is how the console can offer the grant
   * — and on items a rule approved, which is how history shows which rule acted.
   */
  grantEntry: string | null;
  /** The consequence the provider declared, recorded with the offer. */
  grantConsequence: Consequence | null;
  createdAt: number;
}

export class ApprovalIntegrityError extends Error {
  constructor(readonly approvalId: string) {
    super(
      `approval ${approvalId}: payload changed after it was approved — refusing to execute and re-queueing for review`,
    );
    this.name = 'ApprovalIntegrityError';
  }
}

export class ApprovalQueue {
  private readonly rules: StandingRules;

  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {
    this.rules = new StandingRules(db, now);
  }

  /** Standing rules, for callers that grant or revoke them. */
  get standingRules(): StandingRules {
    return this.rules;
  }

  /**
   * Snapshot a proposed action and put it in front of a human.
   *
   * When `grant` describes an action a standing rule already covers, the item
   * is approved on the spot — but it is still inserted as `pending` first and
   * then decided, so the row shows the same lifecycle as a human decision and
   * names the rule that acted. An item approved by rule that nothing executes
   * is still visible as an approval, not as a publish that appeared from
   * nowhere.
   */
  enqueue(input: {
    kind: ApprovalKind;
    refId: string;
    payload: unknown;
    scheduledFor?: Date | null;
    grant?: GrantContext;
  }): Approval {
    const id = newId('appr');
    const createdAt = this.now();
    const serialized = JSON.stringify(input.payload);
    const hash = payloadHash(input.payload);
    const scheduledFor = input.scheduledFor ? input.scheduledFor.getTime() : null;
    // Null for anything a rule could never cover — an irreversible platform
    // never even displays the offer.
    const grantEntry = grantCandidate(input.grant);

    const grantConsequence = grantEntry ? input.grant!.consequence : null;

    this.db
      .prepare(
        `INSERT INTO approvals
           (id, kind, ref_id, state, payload, payload_hash, scheduled_for, grant_entry, grant_consequence, created_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.kind,
        input.refId,
        serialized,
        hash,
        scheduledFor,
        grantEntry,
        grantConsequence,
        createdAt,
      );

    const covering = this.rules.covers(input.grant);
    if (covering) {
      return this.approve(id, { by: `rule:${covering}`, reason: `standing rule: ${covering}` });
    }

    return {
      id,
      kind: input.kind,
      refId: input.refId,
      state: 'pending',
      payload: input.payload,
      payloadHash: hash,
      scheduledFor,
      decidedBy: null,
      decidedAt: null,
      reason: null,
      grantEntry,
      grantConsequence,
      createdAt,
    };
  }

  /**
   * Turn the offer on a pending item into a standing rule, then approve it.
   *
   * The classification comes from the row — recorded when the provider proposed
   * the action — so a caller cannot grant an irreversible platform by asserting
   * a friendlier consequence.
   */
  grantFrom(id: string, by = 'local'): { rule: string; approval: Approval } {
    const appr = this.get(id);
    if (!appr) throw new Error(`approval ${id} not found`);
    if (!appr.grantEntry || !appr.grantConsequence) {
      throw new Error(
        `approval ${id} cannot be covered by a standing rule — it is an action that has to be decided every time`,
      );
    }

    const { action, target } = ruleParts(appr.grantEntry);
    const rule = this.rules.grant({ action, target, consequence: appr.grantConsequence }, by);
    const approval =
      appr.state === 'pending'
        ? this.approve(id, { by: `rule:${rule.entry}`, reason: `standing rule: ${rule.entry}` })
        : appr;
    return { rule: rule.entry, approval };
  }

  get(id: string): Approval | undefined {
    const row = this.db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(id) as any;
    return row ? hydrate(row) : undefined;
  }

  list(state: ApprovalState = 'pending', limit = 50): Approval[] {
    return (
      this.db
        .prepare(`SELECT * FROM approvals WHERE state = ? ORDER BY created_at DESC LIMIT ?`)
        .all(state, limit) as any[]
    ).map(hydrate);
  }

  /**
   * Approve, optionally with edits.
   *
   * When `payload` is supplied the snapshot and hash are replaced, so a human
   * tweaking the text before approving still ends up approving exactly what
   * will ship.
   */
  approve(
    id: string,
    opts: { by?: string; payload?: unknown; scheduledFor?: Date | null; reason?: string } = {},
  ): Approval {
    const existing = this.requirePending(id);
    const payload = 'payload' in opts ? opts.payload : existing.payload;
    const scheduledFor =
      'scheduledFor' in opts
        ? opts.scheduledFor
          ? opts.scheduledFor.getTime()
          : null
        : existing.scheduledFor;

    this.db
      .prepare(
        `UPDATE approvals
            SET state = 'approved', payload = ?, payload_hash = ?, scheduled_for = ?,
                decided_by = ?, decided_at = ?, reason = ?
          WHERE id = ? AND state = 'pending'`,
      )
      .run(
        JSON.stringify(payload),
        payloadHash(payload),
        scheduledFor,
        opts.by ?? 'local',
        this.now(),
        opts.reason ?? null,
        id,
      );

    return this.get(id)!;
  }

  reject(id: string, opts: { by?: string; reason?: string } = {}): Approval {
    this.requirePending(id);
    this.db
      .prepare(
        `UPDATE approvals SET state = 'rejected', decided_by = ?, decided_at = ?, reason = ?
          WHERE id = ? AND state = 'pending'`,
      )
      .run(opts.by ?? 'local', this.now(), opts.reason ?? null, id);
    return this.get(id)!;
  }

  /** Approved items whose scheduled moment has arrived (or that had none). */
  due(at: number = this.now()): Approval[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM approvals
            WHERE state = 'approved' AND (scheduled_for IS NULL OR scheduled_for <= ?)
            ORDER BY created_at ASC`,
        )
        .all(at) as any[]
    ).map(hydrate);
  }

  /**
   * Verify the snapshot still matches before an executor acts on it.
   *
   * Throws ApprovalIntegrityError and returns the item to `pending` if the
   * stored payload no longer hashes to the value recorded at approval time.
   */
  verifyForExecution(id: string): Approval {
    const appr = this.get(id);
    if (!appr) throw new Error(`approval ${id} not found`);
    if (appr.state !== 'approved') {
      throw new Error(`approval ${id} is ${appr.state}, expected approved`);
    }

    if (payloadHash(appr.payload) !== appr.payloadHash) {
      this.db
        .prepare(
          `UPDATE approvals SET state = 'pending', decided_by = NULL, decided_at = NULL,
                                reason = 'payload changed after approval'
            WHERE id = ?`,
        )
        .run(id);
      throw new ApprovalIntegrityError(id);
    }
    return appr;
  }

  /** Time out stale pending items so the queue does not grow unbounded. */
  expireOlderThan(ms: number): number {
    const cutoff = this.now() - ms;
    return this.db
      .prepare(`UPDATE approvals SET state = 'expired' WHERE state = 'pending' AND created_at < ?`)
      .run(cutoff).changes;
  }

  private requirePending(id: string): Approval {
    const appr = this.get(id);
    if (!appr) throw new Error(`approval ${id} not found`);
    if (appr.state !== 'pending') {
      // Guards against a double decision racing in from CLI and web UI at once.
      throw new Error(`approval ${id} is already ${appr.state}`);
    }
    return appr;
  }
}

function hydrate(row: any): Approval {
  return {
    id: row.id,
    kind: row.kind,
    refId: row.ref_id,
    state: row.state,
    payload: JSON.parse(row.payload),
    payloadHash: row.payload_hash,
    scheduledFor: row.scheduled_for,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    reason: row.reason,
    grantEntry: row.grant_entry ?? null,
    grantConsequence: row.grant_consequence ?? null,
    createdAt: row.created_at,
  };
}
