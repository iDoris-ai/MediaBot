import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { open, SCHEMA_VERSION, TABLES } from './db';

function tmpDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mediabot-test-')), 'db', 'mediabot.db');
}

test('creates every table and reaches the latest schema version', () => {
  const db = open(tmpDbPath());
  const names = new Set(
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r: any) => r.name),
  );
  for (const t of TABLES) assert.ok(names.has(t), `missing table: ${t}`);
  assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  db.close();
});

test('creates the directory when it does not exist', () => {
  const p = tmpDbPath();
  assert.ok(!fs.existsSync(path.dirname(p)));
  open(p).close();
  assert.ok(fs.existsSync(p));
});

test('re-opening is idempotent and preserves data', () => {
  const p = tmpDbPath();
  const first = open(p);
  first
    .prepare(`INSERT INTO runs (id, kind, state, started_at) VALUES (?, ?, ?, ?)`)
    .run('run_1', 'source_poll', 'ok', Date.now());
  first.close();

  const second = open(p);
  assert.equal((second.prepare(`SELECT COUNT(*) c FROM runs`).get() as any).c, 1);
  assert.equal(second.pragma('user_version', { simple: true }), SCHEMA_VERSION);
  second.close();
});

test('WAL and foreign keys are enabled', () => {
  const db = open(tmpDbPath());
  assert.equal(String(db.pragma('journal_mode', { simple: true })).toLowerCase(), 'wal');
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  db.close();
});

test('posts.idempotency_key is UNIQUE — the double-publish guard', () => {
  const db = open(tmpDbPath());
  const now = Date.now();
  db.prepare(
    `INSERT INTO accounts (id, platform, provider_id, transport, display_name, state, created_at, updated_at)
     VALUES ('acc_1','xhs','xhs','browser','me','active',?,?)`,
  ).run(now, now);

  const insertPost = (id: string) =>
    db
      .prepare(
        `INSERT INTO posts (id, platform, account_id, state, idempotency_key, created_at, updated_at)
         VALUES (?, 'xhs', 'acc_1', 'queued', 'SAME_KEY', ?, ?)`,
      )
      .run(id, now, now);

  insertPost('post_1');
  assert.throws(() => insertPost('post_2'), /UNIQUE/i, 'replay must not create a second post');
  db.close();
});

test('foreign keys reject a post on a non-existent account', () => {
  const db = open(tmpDbPath());
  const now = Date.now();
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO posts (id, platform, account_id, state, idempotency_key, created_at, updated_at)
           VALUES ('post_x','xhs','ghost_account','queued','k',?,?)`,
        )
        .run(now, now),
    /FOREIGN KEY/i,
  );
  db.close();
});

test('source_items primary key makes repeated polling idempotent', () => {
  const db = open(tmpDbPath());
  const insert = db.prepare(
    `INSERT OR IGNORE INTO source_items (id, provider_id, kind, title, fetched_at)
     VALUES ('rss:item-1', 'rss', 'news', ?, ?)`,
  );
  insert.run('First seen title', Date.now());
  insert.run('Same item polled again', Date.now());

  const rows = db.prepare(`SELECT title FROM source_items`).all() as any[];
  assert.equal(rows.length, 1, 're-polling the same item must not duplicate');
  assert.equal(rows[0].title, 'First seen title');
  db.close();
});
