import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalIntegrityError, ApprovalQueue } from './approval';
import { open } from './db';

function queue() {
  const db = open(':memory:');
  return { db, q: new ApprovalQueue(db) };
}

const payload = { platform: 'xiaohongshu', body: 'hello world', media: [] };

test('enqueued items start pending and are listed', () => {
  const { q } = queue();
  const a = q.enqueue({ kind: 'publish', refId: 'dv_1', payload });

  assert.equal(a.state, 'pending');
  assert.deepEqual(q.list('pending').map((x) => x.id), [a.id]);
  assert.deepEqual(q.get(a.id)!.payload, payload);
});

test('approve then verify passes for untouched payload', () => {
  const { q } = queue();
  const a = q.enqueue({ kind: 'publish', refId: 'dv_1', payload });
  q.approve(a.id, { by: 'jason' });

  const verified = q.verifyForExecution(a.id);
  assert.equal(verified.state, 'approved');
  assert.equal(verified.decidedBy, 'jason');
});

test('payload tampered after approval is refused and re-queued', () => {
  const { db, q } = queue();
  const a = q.enqueue({ kind: 'publish', refId: 'dv_1', payload });
  q.approve(a.id);

  // Simulate anything that rewrites the row without going through approve().
  db.prepare(`UPDATE approvals SET payload = ? WHERE id = ?`).run(
    JSON.stringify({ ...payload, body: 'SPAM LINK' }),
    a.id,
  );

  assert.throws(() => q.verifyForExecution(a.id), ApprovalIntegrityError);
  assert.equal(q.get(a.id)!.state, 'pending', 'must return to review, not stay approved');
  assert.match(q.get(a.id)!.reason ?? '', /payload changed/);
});

test('approving with edits re-snapshots so the edit is what ships', () => {
  const { q } = queue();
  const a = q.enqueue({ kind: 'publish', refId: 'dv_1', payload });
  const edited = { ...payload, body: 'human edited body' };
  q.approve(a.id, { payload: edited });

  const verified = q.verifyForExecution(a.id);
  assert.deepEqual(verified.payload, edited);
});

test('rejected items never become executable', () => {
  const { q } = queue();
  const a = q.enqueue({ kind: 'publish', refId: 'dv_1', payload });
  q.reject(a.id, { reason: 'off brand' });

  assert.equal(q.get(a.id)!.state, 'rejected');
  assert.deepEqual(q.due(), []);
  assert.throws(() => q.verifyForExecution(a.id), /expected approved/);
});

test('a second decision on the same item is refused', () => {
  const { q } = queue();
  const a = q.enqueue({ kind: 'publish', refId: 'dv_1', payload });
  q.approve(a.id);

  assert.throws(() => q.approve(a.id), /already approved/);
  assert.throws(() => q.reject(a.id), /already approved/);
});

test('due() respects the scheduled time', () => {
  const { q } = queue();
  const now = Date.now();
  const later = q.enqueue({
    kind: 'publish',
    refId: 'dv_late',
    payload,
    scheduledFor: new Date(now + 60_000),
  });
  const immediate = q.enqueue({ kind: 'publish', refId: 'dv_now', payload });
  q.approve(later.id);
  q.approve(immediate.id);

  assert.deepEqual(q.due(now).map((x) => x.refId), ['dv_now']);
  assert.equal(q.due(now + 61_000).length, 2);
});

test('pending items are never due, however old', () => {
  const { q } = queue();
  q.enqueue({ kind: 'publish', refId: 'dv_1', payload });
  assert.deepEqual(q.due(Date.now() + 86_400_000), []);
});

test('stale pending items expire', () => {
  const { q } = queue();
  let clock = 1_000_000;
  const qq = new ApprovalQueue(open(':memory:'), () => clock);
  const a = qq.enqueue({ kind: 'publish', refId: 'dv_1', payload });

  clock += 10_000;
  assert.equal(qq.expireOlderThan(60_000), 0, 'not stale yet');
  clock += 120_000;
  assert.equal(qq.expireOlderThan(60_000), 1);
  assert.equal(qq.get(a.id)!.state, 'expired');
  void q;
});

test('reply approvals share the same gate as publishes', () => {
  const { q } = queue();
  const a = q.enqueue({ kind: 'reply', refId: 'xhs:comment-1', payload: { text: 'thanks!' } });
  q.approve(a.id);
  assert.equal(q.verifyForExecution(a.id).kind, 'reply');
});
