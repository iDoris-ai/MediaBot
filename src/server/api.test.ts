import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, isLoopback } from './api';
import { open } from '../core/db';
import { ApprovalQueue } from '../core/approval';

async function serve(onExecute?: () => Promise<any>) {
  const db = open(':memory:');
  const queue = new ApprovalQueue(db);
  const server = createServer({ db, ...(onExecute ? { onExecute } : {}) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  const base = `http://127.0.0.1:${port}`;
  return {
    db,
    queue,
    base,
    close: () => new Promise<void>((r) => server.close(() => r())),
    get: (p: string) => fetch(`${base}${p}`),
    json: async (p: string): Promise<any> => (await fetch(`${base}${p}`)).json(),
    post: (p: string, body?: unknown) =>
      fetch(`${base}${p}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      }),
  };
}

const payload = { platform: 'dryrun', title: 'T', body: 'original body', media: [] };

test('serves the console at /', async () => {
  const s = await serve();
  const res = await s.get('/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type')!, /text\/html/);
  assert.match(await res.text(), /MediaBot/);
  await s.close();
});

test('lists pending approvals', async () => {
  const s = await serve();
  s.queue.enqueue({ kind: 'publish', refId: 'dv_1', payload });

  const { approvals } = await s.json('/api/approvals');
  assert.equal(approvals.length, 1);
  assert.deepEqual(approvals[0].payload, payload);
  await s.close();
});

test('approving triggers execution', async () => {
  let executed = 0;
  const s = await serve(async () => {
    executed += 1;
    return { published: [{}], failed: [] };
  });
  const a = s.queue.enqueue({ kind: 'publish', refId: 'dv_1', payload });

  const res = await s.post(`/api/approvals/${a.id}/approve`);
  assert.equal(res.status, 200);
  assert.equal(executed, 1);
  assert.equal(s.queue.get(a.id)!.state, 'approved');
  await s.close();
});

test('an edited payload is what gets approved and stays hash-verifiable', async () => {
  const s = await serve();
  const a = s.queue.enqueue({ kind: 'publish', refId: 'dv_1', payload });

  await s.post(`/api/approvals/${a.id}/approve`, {
    payload: { ...payload, body: 'edited by reviewer' },
    executeNow: false,
  });

  const verified = s.queue.verifyForExecution(a.id);
  assert.equal((verified.payload as any).body, 'edited by reviewer');
  await s.close();
});

test('scheduling defers execution instead of publishing now', async () => {
  let executed = 0;
  const s = await serve(async () => {
    executed += 1;
    return { published: [], failed: [] };
  });
  const a = s.queue.enqueue({ kind: 'publish', refId: 'dv_1', payload });
  const future = Date.now() + 3_600_000;

  await s.post(`/api/approvals/${a.id}/approve`, { scheduledFor: future, executeNow: false });

  assert.equal(executed, 0, 'a scheduled item must not publish immediately');
  assert.equal(s.queue.get(a.id)!.scheduledFor, future);
  assert.deepEqual(s.queue.due(Date.now()), [], 'not due yet');
  await s.close();
});

test('rejecting records the reason and blocks execution', async () => {
  const s = await serve();
  const a = s.queue.enqueue({ kind: 'publish', refId: 'dv_1', payload });

  await s.post(`/api/approvals/${a.id}/reject`, { reason: 'off brand' });

  const after = s.queue.get(a.id)!;
  assert.equal(after.state, 'rejected');
  assert.equal(after.reason, 'off brand');
  assert.throws(() => s.queue.verifyForExecution(a.id));
  await s.close();
});

test('deciding twice on the same item is an error, not a double publish', async () => {
  const s = await serve(async () => ({ published: [], failed: [] }));
  const a = s.queue.enqueue({ kind: 'publish', refId: 'dv_1', payload });

  assert.equal((await s.post(`/api/approvals/${a.id}/approve`)).status, 200);
  const second = await s.post(`/api/approvals/${a.id}/approve`);
  assert.equal(second.status, 500);
  assert.match(((await second.json()) as any).error, /already approved/);
  await s.close();
});

test('status and list endpoints report the database', async () => {
  const s = await serve();
  s.queue.enqueue({ kind: 'publish', refId: 'dv_1', payload });
  s.db
    .prepare(`INSERT INTO source_items (id, provider_id, kind, title, fetched_at) VALUES (?,?,?,?,?)`)
    .run('rss:1', 'rss', 'news', 'Something', Date.now());
  s.db
    .prepare(`INSERT INTO runs (id, kind, state, started_at) VALUES (?,?,?,?)`)
    .run('run_1', 'source_poll', 'ok', Date.now());

  assert.deepEqual(
    { pending: 1, sourceItems: 1 },
    await s.json('/api/status').then((x: any) => ({ pending: x.pending, sourceItems: x.sourceItems })),
  );
  assert.equal((await s.json('/api/sources')).items.length, 1);
  assert.equal((await s.json('/api/runs')).runs.length, 1);
  assert.equal((await s.json('/api/posts')).posts.length, 0);
  await s.close();
});

test('unknown routes 404', async () => {
  const s = await serve();
  assert.equal((await s.get('/api/nope')).status, 404);
  await s.close();
});

test('isLoopback accepts only loopback addresses', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.1.1']) {
    assert.ok(isLoopback(a), `${a} should be loopback`);
  }
  for (const a of ['192.168.1.10', '10.0.0.5', '::ffff:192.168.1.10', '8.8.8.8', '']) {
    assert.ok(!isLoopback(a), `${a} must be rejected — the DB holds credentials and queued posts`);
  }
});
