import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBriefingPrompt, generateBriefing } from './briefing';
import { open } from './db';

function seed(db: ReturnType<typeof open>, rows: Array<Partial<Record<string, any>>>) {
  const stmt = db.prepare(
    `INSERT INTO source_items (id, provider_id, kind, title, url, summary, score, published_at, fetched_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  for (const r of rows) {
    stmt.run(
      r.id,
      r.provider_id ?? 'rss',
      r.kind ?? 'news',
      r.title ?? 'untitled',
      r.url ?? null,
      r.summary ?? null,
      r.score ?? null,
      r.published_at ?? null,
      r.fetched_at ?? Date.now(),
    );
  }
}

const NOW = 1_800_000_000_000;
const stub = (text: string) => async () => ({ text, transcript: '' });

test('summarises recent items via the model', async () => {
  const db = open(':memory:');
  seed(db, [
    { id: 'a:1', title: '话题一', score: 100, fetched_at: NOW - 1000 },
    { id: 'a:2', title: '话题二', score: 50, fetched_at: NOW - 2000 },
  ]);

  const b = await generateBriefing(db, { now: () => NOW, runner: stub('三条关键判断…') });
  assert.equal(b.itemCount, 2);
  assert.equal(b.text, '三条关键判断…');
  assert.deepEqual(b.items.map((i) => i.title), ['话题一', '话题二']);
});

test('items outside the window are excluded', async () => {
  const db = open(':memory:');
  seed(db, [
    { id: 'a:new', title: '新的', fetched_at: NOW - 3600_000 },
    { id: 'a:old', title: '两天前', fetched_at: NOW - 48 * 3600_000 },
  ]);

  const b = await generateBriefing(db, { now: () => NOW, runner: stub('ok') });
  assert.deepEqual(b.items.map((i) => i.title), ['新的']);
});

test('items are ranked by score', async () => {
  const db = open(':memory:');
  seed(db, [
    { id: 'a:low', title: '低', score: 5, fetched_at: NOW },
    { id: 'a:high', title: '高', score: 900, fetched_at: NOW },
  ]);
  const b = await generateBriefing(db, { now: () => NOW, runner: stub('ok') });
  assert.deepEqual(b.items.map((i) => i.title), ['高', '低']);
});

test('an empty window produces a briefing, not an error or a model call', async () => {
  const db = open(':memory:');
  let called = false;
  const b = await generateBriefing(db, {
    now: () => NOW,
    runner: async () => {
      called = true;
      return { text: 'x', transcript: '' };
    },
  });
  assert.equal(b.itemCount, 0);
  assert.match(b.text, /没有新的监控信号/);
  assert.equal(called, false, 'no signals means no reason to spend a model call');
});

test('a model failure still yields the raw findings', async () => {
  const db = open(':memory:');
  seed(db, [{ id: 'a:1', title: '重要信号', url: 'https://e.com/1', fetched_at: NOW }]);

  const b = await generateBriefing(db, {
    now: () => NOW,
    runner: async () => {
      throw new Error('claude unavailable');
    },
  });

  assert.equal(b.itemCount, 1);
  assert.match(b.text, /重要信号/, 'the poll must not be lost just because the model is down');
  assert.match(b.text, /模型不可用/);
});

test('an empty model response falls back to the listing', async () => {
  const db = open(':memory:');
  seed(db, [{ id: 'a:1', title: '信号', fetched_at: NOW }]);
  const b = await generateBriefing(db, { now: () => NOW, runner: stub('   ') });
  assert.match(b.text, /信号/);
});

test('generating a briefing records a run and creates nothing else', async () => {
  const db = open(':memory:');
  seed(db, [{ id: 'a:1', title: '信号', fetched_at: NOW }]);
  await generateBriefing(db, { now: () => NOW, runner: stub('summary') });

  const runs = db.prepare(`SELECT kind, state FROM runs`).all() as any[];
  assert.deepEqual(runs, [{ kind: 'briefing', state: 'ok' }]);

  // The critical invariant: monitoring may inform, never act.
  for (const t of ['drafts', 'draft_variants', 'approvals', 'posts']) {
    assert.equal(
      (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as any).c,
      0,
      `briefing must not create rows in ${t} — monitoring is eyes, not hands`,
    );
  }
});

test('the prompt carries the signals and forbids autoposting advice', () => {
  const p = buildBriefingPrompt(
    [{ provider_id: 'xhs-search', title: '某个热点', score: 1000, url: 'https://e.com', summary: '摘要' }],
    'zh-CN',
  );
  assert.match(p, /某个热点/);
  assert.match(p, /xhs-search/);
  assert.match(p, /热度: 1000/);
  assert.match(p, /不要建议自动发布/);
  assert.match(p, /不要写文案本身/);
});
