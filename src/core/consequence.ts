import type { Consequence, DraftVariant, PublisherProvider } from '../contracts';
import type { Db } from './db';

/**
 * How far an action can be taken back, and what that permits.
 *
 * The approval gate was binary: every outbound action asks, forever. That is
 * safe but wrong in one direction — publishing to a git-backed blog is one
 * `git revert` away from undone, while a XiaoHongShu post is permanent. Asking
 * identically about both trains the human to click approve without reading,
 * which is how an irreversible post eventually goes out unread.
 *
 * So consequence is a declared property with one place that reads it, and it
 * governs exactly one thing: whether a standing rule may pre-approve this kind
 * of action. Everything still passes through the queue and still gets a row.
 *
 * The grant is bound to an exact target, never to a platform name. "Always
 * allow publishing to blog-tech" would keep applying after the config is
 * repointed at a different repository; "always allow publishing to
 * /Users/me/blog#src/content/blog" stops matching the moment the target
 * changes, which is the behaviour you want from a permission you granted once
 * and forgot about.
 *
 * Pattern borrowed from openworker's `permissions.py::standing_rule_candidate`
 * and `automation/models.py::grant_entries` (MIT, Copyright 2024 Andrew Ng).
 */

/** Consequence classes a standing rule may cover. */
const GRANTABLE: ReadonlySet<Consequence> = new Set<Consequence>([
  'local', // never leaves the machine
  'reversible', // git-backed: undoing it is a revert
  'draft_only', // a human still presses send on the platform
]);

/**
 * The consequence of publishing through this provider.
 *
 * A provider that does not declare one is treated as irreversible. Fail-closed:
 * the cost of over-asking is a click, the cost of under-asking is a post that
 * cannot be taken back.
 */
export function consequenceOf(publisher: PublisherProvider): Consequence {
  return publisher.consequence ?? 'irreversible';
}

export function isGrantable(consequence: Consequence): boolean {
  return GRANTABLE.has(consequence);
}

export interface GrantContext {
  /** `publish:<platform>` / `reply:<platform>`. Never contains a space. */
  action: string;
  target: string;
  consequence: Consequence;
}

/** `"<action> <target>"` — one space; actions never contain one. */
export function ruleEntry(action: string, target: string): string {
  return `${action} ${target}`;
}

export function ruleParts(entry: string): { action: string; target: string } {
  const idx = entry.indexOf(' ');
  return idx < 0
    ? { action: entry.trim(), target: '' }
    : { action: entry.slice(0, idx).trim(), target: entry.slice(idx + 1).trim() };
}

/**
 * The rule entry this action could be covered by, or null if it can never be.
 *
 * Three ways to be ineligible, all fail-closed: the consequence is not
 * grantable, the provider declares no target, or the target is empty.
 */
export function grantCandidate(ctx: GrantContext | undefined): string | null {
  if (!ctx) return null;
  if (!isGrantable(ctx.consequence)) return null;
  const target = ctx.target.trim();
  if (!target || !ctx.action.trim()) return null;
  return ruleEntry(ctx.action, target);
}

/** Build the grant context for publishing one variant, if the provider allows it. */
export function publishGrant(
  publisher: PublisherProvider,
  variant: DraftVariant,
): GrantContext | undefined {
  const target = publisher.targetFor?.(variant);
  if (!target) return undefined;
  return {
    action: `publish:${publisher.platform}`,
    target,
    consequence: consequenceOf(publisher),
  };
}

export interface StandingRule {
  entry: string;
  action: string;
  target: string;
  consequence: Consequence;
  createdBy: string | null;
  createdAt: number;
}

/**
 * Standing rules, persisted.
 *
 * Deliberately a tiny table with the entry as the primary key: granting twice
 * is a no-op, and revoking is a single delete, so "what am I currently
 * auto-approving" is one query with no reconstruction.
 */
export class StandingRules {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {}

  /**
   * Record a rule. Rejects anything not grantable, so a caller cannot mint a
   * rule for an irreversible platform by constructing the entry by hand.
   */
  grant(ctx: GrantContext, by = 'local'): StandingRule {
    const entry = grantCandidate(ctx);
    if (!entry) {
      throw new Error(
        `refusing to grant "${ctx.action} ${ctx.target}": ${ctx.consequence} actions cannot be pre-approved` +
          ` — they cannot be undone, so each one needs a human`,
      );
    }
    const createdAt = this.now();
    this.db
      .prepare(
        `INSERT INTO standing_rules (entry, action, target, consequence, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(entry) DO NOTHING`,
      )
      .run(entry, ctx.action, ctx.target.trim(), ctx.consequence, by, createdAt);
    return this.get(entry)!;
  }

  get(entry: string): StandingRule | undefined {
    const row = this.db.prepare(`SELECT * FROM standing_rules WHERE entry = ?`).get(entry) as any;
    return row ? hydrate(row) : undefined;
  }

  /** Does a rule cover this action? A null candidate can never match. */
  covers(ctx: GrantContext | undefined): string | null {
    const entry = grantCandidate(ctx);
    if (!entry) return null;
    return this.get(entry) ? entry : null;
  }

  list(): StandingRule[] {
    return (
      this.db.prepare(`SELECT * FROM standing_rules ORDER BY created_at DESC`).all() as any[]
    ).map(hydrate);
  }

  /** Returns whether anything was removed, so the CLI can report honestly. */
  revoke(entry: string): boolean {
    return this.db.prepare(`DELETE FROM standing_rules WHERE entry = ?`).run(entry).changes > 0;
  }
}

function hydrate(row: any): StandingRule {
  return {
    entry: row.entry,
    action: row.action,
    target: row.target,
    consequence: row.consequence,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}
