import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

/**
 * SQLite storage layer. Schema is defined in docs/spec.md §2.
 *
 * Migrations are an ordered, append-only list keyed by `user_version`. Never
 * edit a migration that has shipped — add a new one. `open()` is idempotent, so
 * it is safe to call on every process start.
 */

export type Db = Database.Database;

interface Migration {
  version: number;
  up: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE goals (
        id                   TEXT PRIMARY KEY,
        title                TEXT    NOT NULL,
        metric               TEXT    NOT NULL,
        baseline             REAL,
        baseline_measured_at INTEGER,
        target               REAL,
        deadline             INTEGER,
        cadence              TEXT,
        state                TEXT    NOT NULL,
        created_at           INTEGER NOT NULL,
        updated_at           INTEGER NOT NULL
      );

      CREATE TABLE goal_checks (
        id         TEXT PRIMARY KEY,
        goal_id    TEXT    NOT NULL REFERENCES goals(id),
        measured   REAL,
        predicted  REAL,
        note       TEXT,
        checked_at INTEGER NOT NULL
      );
      CREATE INDEX idx_goal_checks_goal ON goal_checks(goal_id, checked_at DESC);

      CREATE TABLE source_items (
        id           TEXT PRIMARY KEY,
        provider_id  TEXT    NOT NULL,
        kind         TEXT    NOT NULL,
        title        TEXT    NOT NULL,
        url          TEXT,
        summary      TEXT,
        score        REAL,
        locale       TEXT,
        published_at INTEGER,
        raw          TEXT,
        fetched_at   INTEGER NOT NULL
      );
      CREATE INDEX idx_source_items_fetched ON source_items(fetched_at DESC);
      CREATE INDEX idx_source_items_kind    ON source_items(kind, published_at DESC);

      CREATE TABLE drafts (
        id          TEXT PRIMARY KEY,
        goal_id     TEXT REFERENCES goals(id),
        brief       TEXT    NOT NULL,
        composer_id TEXT    NOT NULL,
        state       TEXT    NOT NULL,
        error       TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      CREATE TABLE draft_variants (
        id         TEXT PRIMARY KEY,
        draft_id   TEXT    NOT NULL REFERENCES drafts(id),
        platform   TEXT    NOT NULL,
        title      TEXT,
        body       TEXT    NOT NULL,
        media      TEXT,
        meta       TEXT,
        validation TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_variants_draft ON draft_variants(draft_id);

      CREATE TABLE accounts (
        id             TEXT PRIMARY KEY,
        platform       TEXT    NOT NULL,
        provider_id    TEXT    NOT NULL,
        transport      TEXT    NOT NULL,
        display_name   TEXT,
        credential_ref TEXT,
        state          TEXT    NOT NULL,
        posting_times  TEXT,
        settings       TEXT,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX idx_accounts_platform_name ON accounts(platform, display_name);

      CREATE TABLE approvals (
        id            TEXT PRIMARY KEY,
        kind          TEXT    NOT NULL,
        ref_id        TEXT    NOT NULL,
        state         TEXT    NOT NULL,
        payload       TEXT    NOT NULL,
        payload_hash  TEXT    NOT NULL,
        scheduled_for INTEGER,
        decided_by    TEXT,
        decided_at    INTEGER,
        reason        TEXT,
        created_at    INTEGER NOT NULL
      );
      CREATE INDEX idx_approvals_state ON approvals(state, created_at DESC);

      CREATE TABLE posts (
        id               TEXT PRIMARY KEY,
        draft_variant_id TEXT REFERENCES draft_variants(id),
        approval_id      TEXT REFERENCES approvals(id),
        platform         TEXT    NOT NULL,
        account_id       TEXT    NOT NULL REFERENCES accounts(id),
        state            TEXT    NOT NULL,
        platform_post_id TEXT,
        url              TEXT,
        scheduled_for    INTEGER,
        published_at     INTEGER,
        attempts         INTEGER NOT NULL DEFAULT 0,
        error            TEXT,
        idempotency_key  TEXT    NOT NULL UNIQUE,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL
      );
      CREATE INDEX idx_posts_state_sched ON posts(state, scheduled_for);

      CREATE TABLE comments (
        id                TEXT PRIMARY KEY,
        post_id           TEXT REFERENCES posts(id),
        platform          TEXT    NOT NULL,
        author            TEXT,
        body              TEXT,
        published_at      INTEGER,
        state             TEXT    NOT NULL,
        reply_draft       TEXT,
        reply_platform_id TEXT,
        fetched_at        INTEGER NOT NULL
      );
      CREATE INDEX idx_comments_state ON comments(state, published_at DESC);

      CREATE TABLE runs (
        id          TEXT PRIMARY KEY,
        kind        TEXT    NOT NULL,
        provider_id TEXT,
        ref_id      TEXT,
        state       TEXT    NOT NULL,
        detail      TEXT,
        cost_usd    REAL,
        started_at  INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE INDEX idx_runs_started ON runs(started_at DESC);
    `,
  },
  {
    // T9.3 — record what a run was actually called with. Always written through
    // `sanitizeArgs`; see src/core/audit.ts for why this column is not raw.
    version: 2,
    up: `ALTER TABLE runs ADD COLUMN args TEXT;`,
  },
  {
    // T9.2 — standing approvals, bound to an exact target. See
    // src/core/consequence.ts for why the target is part of the key.
    version: 3,
    up: `
      CREATE TABLE standing_rules (
        entry       TEXT PRIMARY KEY,   -- "<action> <target>"
        action      TEXT    NOT NULL,
        target      TEXT    NOT NULL,
        consequence TEXT    NOT NULL,   -- as classified when granted
        created_by  TEXT,
        created_at  INTEGER NOT NULL
      );

      -- The rule this approval could be (or was) covered by. Kept on the row so
      -- the console can offer the grant, and so history shows which rule acted.
      -- The consequence rides along because the grant must be recorded with the
      -- classification the provider declared, never one a caller supplied.
      ALTER TABLE approvals ADD COLUMN grant_entry TEXT;
      ALTER TABLE approvals ADD COLUMN grant_consequence TEXT;
    `,
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/** Open (creating if needed) and bring the database up to the latest schema. */
export function open(dbPath: string): Db {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  // Referential integrity is off by default in SQLite; the schema relies on it.
  db.pragma('foreign_keys = ON');

  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number;

  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    // DDL plus the version bump must land together, or a crash mid-migration
    // would leave the schema half-applied and un-replayable.
    db.transaction(() => {
      db.exec(m.up);
      db.pragma(`user_version = ${m.version}`);
    })();
  }
}

/** Table names the schema is expected to contain — used by tests and doctor. */
export const TABLES = [
  'goals',
  'goal_checks',
  'source_items',
  'drafts',
  'draft_variants',
  'accounts',
  'approvals',
  'posts',
  'comments',
  'runs',
  'standing_rules',
] as const;
