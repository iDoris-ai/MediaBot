import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApprovalQueue } from '../../core/approval';
import { replyToken } from '../../core/approval-reply';
import { open } from '../../core/db';
import { TelegramEngagement } from '../engagement/telegram';
import { wireReplyApproval, type ReplyApprovalWiring } from './approval-poller';

const OWNER = '4242';
const payload = { platform: 'xiaohongshu', title: 'T', body: 'body', media: [] };

function queueWithItem() {
  const queue = new ApprovalQueue(open(':memory:'));
  const appr = queue.enqueue({ kind: 'publish', refId: 'dv_1', payload });
  return { queue, appr };
}

/**
 * A fetch double for the Bot API: one canned getUpdates batch, then nothing.
 *
 * It has to answer `getMe` too — the engagement provider asks for its own
 * username before polling, and a double that returns the updates to that call
 * instead makes the real poll come back empty.
 */
function fakeUpdates(messages: any[]): typeof fetch {
  let served = false;
  return (async (url: string) => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (String(url).endsWith('/getMe')) {
      return json({ ok: true, result: { id: 1, is_bot: true, username: 'mediabot' } });
    }
    const result = served ? [] : messages.map((m, i) => ({ update_id: i + 1, message: m }));
    served = true;
    return json({ ok: true, result });
  }) as unknown as typeof fetch;
}

test('stays off when no owner is configured', () => {
  const { queue } = queueWithItem();
  const wiring = wireReplyApproval({ queue, config: { token: 't' } });
  assert.equal(wiring.mode, 'disabled');
  assert.match((wiring as any).reason, /telegramOwnerId/);
});

test('attaches to the group provider instead of starting a second poller', () => {
  const { queue } = queueWithItem();
  const engagement = new TelegramEngagement({ token: 'bot-token' });

  const wiring = wireReplyApproval({
    queue,
    config: { ownerId: OWNER, token: 'bot-token' },
    engagement,
  });

  // Two getUpdates consumers on one token steal each other's messages, so the
  // presence of the group provider must rule out polling entirely.
  assert.equal(wiring.mode, 'attached');
  assert.ok(!('poller' in wiring), 'must not create a poller alongside the engagement provider');
  assert.equal(typeof engagement.onMessage, 'function');
});

test('polls on its own only when nothing else owns the stream', () => {
  const { queue } = queueWithItem();
  const wiring = wireReplyApproval({ queue, config: { ownerId: OWNER, token: 'bot-token' } });
  assert.equal(wiring.mode, 'polling');
});

test('the attached hook decides an approval from a real update', async () => {
  const { queue, appr } = queueWithItem();
  const engagement = new TelegramEngagement({
    token: 'bot-token',
    fetchImpl: fakeUpdates([
      {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: -100, type: 'group' },
        from: { id: Number(OWNER), is_bot: false, username: 'jason' },
        text: `批准 ${replyToken(appr.id)}`,
      },
    ]),
  });

  const seen: ReplyApprovalWiring[] = [];
  wireReplyApproval({
    queue,
    config: { ownerId: OWNER },
    engagement,
    onOutcome: () => seen.push({} as any),
  });

  await engagement.listComments({ postId: 'p', platform: 'telegram', platformPostId: 'x' } as any);

  assert.equal(queue.get(appr.id)!.state, 'approved');
  assert.equal(seen.length, 1);
});

test('a group member who is not the owner cannot approve through the hook', async () => {
  const { queue, appr } = queueWithItem();
  const engagement = new TelegramEngagement({
    token: 'bot-token',
    fetchImpl: fakeUpdates([
      {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: -100, type: 'group' },
        from: { id: 999, is_bot: false, username: 'someone-else' },
        text: `批准 ${replyToken(appr.id)}`,
      },
    ]),
  });

  wireReplyApproval({ queue, config: { ownerId: OWNER }, engagement });
  await engagement.listComments({ postId: 'p', platform: 'telegram', platformPostId: 'x' } as any);

  assert.equal(queue.get(appr.id)!.state, 'pending');
});

test('a throwing hook cannot break the poll that already acked the updates', async () => {
  const engagement = new TelegramEngagement({
    token: 'bot-token',
    fetchImpl: fakeUpdates([
      {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: -100, type: 'private' },
        from: { id: 1, is_bot: false },
        text: 'hello',
      },
    ]),
    onMessage: () => {
      throw new Error('hook exploded');
    },
  });

  const comments = await engagement.listComments({
    postId: 'p',
    platform: 'telegram',
    platformPostId: 'x',
  } as any);
  assert.equal(comments.length, 1, 'the message still became a comment despite the hook failing');
});

test('the standalone poller decides and advances its offset', async () => {
  const { queue, appr } = queueWithItem();
  const wiring = wireReplyApproval({
    queue,
    config: { ownerId: OWNER, token: 'bot-token' },
    fetchImpl: fakeUpdates([
      {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(OWNER), type: 'private' },
        from: { id: Number(OWNER), is_bot: false },
        text: `${replyToken(appr.id)} 批准`,
      },
    ]),
  });
  assert.equal(wiring.mode, 'polling');

  const first = await (wiring as any).poller.poll();
  assert.equal(first.length, 1);
  assert.equal(queue.get(appr.id)!.state, 'approved');

  // Second pass sees nothing new — no re-decision, no error.
  assert.deepEqual(await (wiring as any).poller.poll(), []);
});
