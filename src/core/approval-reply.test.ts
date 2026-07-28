import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApprovalQueue } from './approval';
import { parseApprovalReply, ReplyApprover, replyToken } from './approval-reply';
import { open } from './db';

const OWNER = '12345';
const payload = { platform: 'xiaohongshu', title: 'T', body: 'body', media: [] };

function setup() {
  const queue = new ApprovalQueue(open(':memory:'));
  const approver = new ReplyApprover({ queue, ownerId: OWNER });
  const appr = queue.enqueue({ kind: 'publish', refId: 'dv_1', payload });
  return { queue, approver, appr, token: replyToken(appr.id) };
}

test('an owner reply approves the item it names', () => {
  const { queue, approver, appr, token } = setup();
  const out = approver.apply(`批准 ${token}`, OWNER);

  assert.equal(out.status, 'decided');
  assert.equal(queue.get(appr.id)!.state, 'approved');
  assert.equal(queue.get(appr.id)!.decidedBy, 'telegram-reply');
});

test('a reply from anyone else changes nothing', () => {
  const { queue, approver, appr, token } = setup();

  for (const stranger of ['999', 0, undefined, '']) {
    const out = approver.apply(`批准 ${token}`, stranger as any);
    assert.equal(out.status, 'ignored');
    assert.equal((out as any).reason, 'not_owner');
  }
  assert.equal(queue.get(appr.id)!.state, 'pending', 'a stranger must never move the queue');
});

test('reply approval cannot be constructed without an owner', () => {
  const queue = new ApprovalQueue(open(':memory:'));
  assert.throws(() => new ReplyApprover({ queue, ownerId: '' }), /owner id/);
});

test('ordinary group chatter is not a decision', () => {
  const { queue, approver, appr } = setup();
  for (const text of ['批准吧兄弟们', 'ok 我看过了', '', 'no']) {
    assert.equal(approver.apply(text, OWNER).status, 'ignored');
  }
  assert.equal(queue.get(appr.id)!.state, 'pending');
});

test('a token with no decision word is left alone', () => {
  const { approver, token } = setup();
  const out = approver.apply(`这个我再想想 ${token}`, OWNER);
  assert.equal(out.status, 'ignored');
  assert.equal((out as any).reason, 'no_decision');
});

test('rejection wins when a reply says both', () => {
  const { queue, approver, appr, token } = setup();
  approver.apply(`别发 ok ${token}`, OWNER);
  assert.equal(queue.get(appr.id)!.state, 'rejected');
});

test('the rejection reason keeps the rest of the message', () => {
  const { queue, approver, appr, token } = setup();
  approver.apply(`${token} 拒绝 数字对不上`, OWNER);
  assert.match(queue.get(appr.id)!.reason!, /数字对不上/);
});

test('replying twice does not re-decide', () => {
  const { queue, approver, appr, token } = setup();
  approver.apply(`批准 ${token}`, OWNER);
  const second = approver.apply(`拒绝 ${token}`, OWNER);

  assert.equal(second.status, 'already');
  assert.equal(queue.get(appr.id)!.state, 'approved', 'the first decision stands');
});

test('an unknown or ambiguous token decides nothing', () => {
  const { queue, approver } = setup();
  assert.equal(approver.apply('批准 [mb:appr_nothing]', OWNER).status, 'unknown');

  // Two items sharing the fragment: refusing beats guessing.
  const a = queue.enqueue({ kind: 'publish', refId: 'x', payload });
  const shared = a.id.slice(0, 6);
  queue.enqueue({ kind: 'publish', refId: 'y', payload });
  const collisions = queue.list('pending').filter((i) => i.id.startsWith(shared));
  if (collisions.length > 1) {
    assert.equal(approver.apply(`批准 [mb:${shared}]`, OWNER).status, 'unknown');
  }
});

test('word matching does not fire on substrings', () => {
  const parsed = parseApprovalReply('[mb:appr_abcdef] nothing to say')!;
  assert.equal(parsed.decision, null, '"no" inside "nothing" must not reject');
  assert.equal(parseApprovalReply('[mb:appr_abcdef] YES')!.decision, 'approve');
});

test('the token is stable and short enough to survive a chat client', () => {
  const token = replyToken('appr_0123456789abcdefghij');
  assert.equal(token, '[mb:appr_0123456]');
  assert.equal(parseApprovalReply(`👍 ${token}`)!.idFragment, 'appr_0123456');
});
