import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EngagementRunner, buildReplyPrompt, replyTargetFor } from './engagement';
import { ApprovalQueue } from './approval';
import { open } from './db';
import { ProviderError, type Comment, type EngagementProvider } from '../contracts';

const NOW = 1_800_000_000_000;

function fakeProvider(
  platform: string,
  comments: Comment[],
  sink: { replies: Array<{ target: string; text: string; dryRun?: boolean }> } = { replies: [] },
  failReply?: Error,
): EngagementProvider & { sink: typeof sink } {
  return {
    info: { id: platform, slot: 'engagement', name: platform },
    platform,
    sink,
    listComments: async () => comments,
    reply: async (target, text, options) => {
      if (failReply) throw failReply;
      sink.replies.push({ target, text, ...(options.dryRun ? { dryRun: true } : {}) });
      return { platformReplyId: `reply-${sink.replies.length}`, repliedAt: new Date(NOW) };
    },
  };
}

/** A published post is the anchor for comment polling. */
function seedPost(db: ReturnType<typeof open>, platform = 'xiaohongshu') {
  db.prepare(
    `INSERT INTO accounts (id, platform, provider_id, transport, display_name, state, created_at, updated_at)
     VALUES ('acc_1', ?, ?, 'cli', 'me', 'active', ?, ?)`,
  ).run(platform, platform, NOW, NOW);
  db.prepare(
    `INSERT INTO posts (id, platform, account_id, state, platform_post_id, published_at,
                        idempotency_key, created_at, updated_at)
     VALUES ('post_1', ?, 'acc_1', 'published', 'note123', ?, 'k1', ?, ?)`,
  ).run(platform, NOW, NOW, NOW);
}

const comment = (id: string, body: string, over: Partial<Comment> = {}): Comment => ({
  id,
  platform: 'xiaohongshu',
  postId: 'post_1',
  body,
  author: '读者',
  publishedAt: new Date(NOW - 1000),
  ...over,
});

function runner(
  db: ReturnType<typeof open>,
  provider: EngagementProvider,
  claudeText: string | Error = '谢谢，这个点我也在想。',
) {
  return new EngagementRunner(db, {
    providers: [provider],
    now: () => NOW,
    claude: async () => {
      if (claudeText instanceof Error) throw claudeText;
      return { text: claudeText, transcript: '' };
    },
  });
}

test('polls comments on published posts and stores new ones', async () => {
  const db = open(':memory:');
  seedPost(db);
  const p = fakeProvider('xiaohongshu', [comment('xiaohongshu:c1', '写得好'), comment('xiaohongshu:c2', '同意')]);

  const res = await runner(db, p).poll();

  assert.equal(res.fetched, 2);
  assert.equal(res.stored, 2);
  assert.equal((db.prepare(`SELECT COUNT(*) c FROM comments WHERE state='new'`).get() as any).c, 2);
});

test('re-polling the same thread stores nothing new', async () => {
  const db = open(':memory:');
  seedPost(db);
  const p = fakeProvider('xiaohongshu', [comment('xiaohongshu:c1', '写得好')]);
  const r = runner(db, p);

  await r.poll();
  const second = await r.poll();
  assert.equal(second.fetched, 1);
  assert.equal(second.stored, 0, 'namespaced ids make re-polling idempotent');
});

test('a provider failure is recorded without losing the run', async () => {
  const db = open(':memory:');
  seedPost(db);
  const broken: EngagementProvider = {
    info: { id: 'xhs', slot: 'engagement', name: 'x' },
    platform: 'xiaohongshu',
    listComments: async () => {
      throw new ProviderError('rate limited', 'rate_limited', true);
    },
    reply: async () => ({ platformReplyId: 'r', repliedAt: new Date() }),
  };

  const res = await runner(db, broken).poll();
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0]!.message, /rate limited/);
  assert.equal((db.prepare(`SELECT state FROM runs`).get() as any).state, 'error');
});

test('drafted replies are queued for approval, never sent', async () => {
  const db = open(':memory:');
  seedPost(db);
  const p = fakeProvider('xiaohongshu', [comment('xiaohongshu:c1', '这个工具怎么装？')]);
  const r = runner(db, p);

  await r.poll();
  const drafted = await r.draftReplies();

  assert.equal(drafted.drafted, 1);
  assert.equal(p.sink.replies.length, 0, 'drafting must not send anything');

  const queue = new ApprovalQueue(db, () => NOW);
  const pending = queue.list('pending');
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.kind, 'reply');
  assert.equal((pending[0]!.payload as any).body, '谢谢，这个点我也在想。');
  assert.equal((db.prepare(`SELECT state FROM comments`).get() as any).state, 'drafted');
});

test('the model may decline, and the comment is then ignored', async () => {
  const db = open(':memory:');
  seedPost(db);
  const p = fakeProvider('xiaohongshu', [comment('xiaohongshu:spam', '加V看片')]);
  const r = runner(db, p, 'SKIP');

  await r.poll();
  const res = await r.draftReplies();

  assert.equal(res.drafted, 0);
  assert.match(res.skipped[0]!.reason, /declined/);
  assert.equal((db.prepare(`SELECT state FROM comments`).get() as any).state, 'ignored');
  assert.equal(new ApprovalQueue(db).list('pending').length, 0);
});

test('empty comments are ignored without spending a model call', async () => {
  const db = open(':memory:');
  seedPost(db);
  let called = false;
  const p = fakeProvider('xiaohongshu', [comment('xiaohongshu:blank', '   ')]);
  const r = new EngagementRunner(db, {
    providers: [p],
    now: () => NOW,
    claude: async () => {
      called = true;
      return { text: 'x', transcript: '' };
    },
  });

  await r.poll();
  const res = await r.draftReplies();
  assert.equal(called, false);
  assert.match(res.skipped[0]!.reason, /empty/);
});

test('approved replies are sent and the comment is closed out', async () => {
  const db = open(':memory:');
  seedPost(db);
  const p = fakeProvider('xiaohongshu', [comment('xiaohongshu:c1', '好文')]);
  const r = runner(db, p);

  await r.poll();
  await r.draftReplies();

  const queue = new ApprovalQueue(db, () => NOW);
  const pending = queue.list('pending')[0]!;

  assert.deepEqual(await r.sendApproved(), { sent: [], failed: [] }, 'pending must not send');

  queue.approve(pending.id);
  const sent = await r.sendApproved();

  assert.equal(sent.sent.length, 1);
  assert.equal(p.sink.replies.length, 1);
  assert.equal(p.sink.replies[0]!.text, '谢谢，这个点我也在想。');
  assert.equal(p.sink.replies[0]!.target, 'note123/c1', 'XHS needs note id plus comment id');
  assert.equal((db.prepare(`SELECT state FROM comments`).get() as any).state, 'replied');
});

test('a rejected reply is never sent', async () => {
  const db = open(':memory:');
  seedPost(db);
  const p = fakeProvider('xiaohongshu', [comment('xiaohongshu:c1', '好文')]);
  const r = runner(db, p);

  await r.poll();
  await r.draftReplies();
  const queue = new ApprovalQueue(db, () => NOW);
  queue.reject(queue.list('pending')[0]!.id, { reason: 'not worth it' });

  await r.sendApproved();
  assert.equal(p.sink.replies.length, 0);
});

test('editing a reply after drafting still sends the edited text', async () => {
  const db = open(':memory:');
  seedPost(db);
  const p = fakeProvider('xiaohongshu', [comment('xiaohongshu:c1', '好文')]);
  const r = runner(db, p);

  await r.poll();
  await r.draftReplies();
  const queue = new ApprovalQueue(db, () => NOW);
  const a = queue.list('pending')[0]!;
  queue.approve(a.id, { payload: { ...(a.payload as any), body: '人工改过的回复' } });

  await r.sendApproved();
  assert.equal(p.sink.replies[0]!.text, '人工改过的回复');
});

test('a tampered reply payload is refused and re-queued', async () => {
  const db = open(':memory:');
  seedPost(db);
  const p = fakeProvider('xiaohongshu', [comment('xiaohongshu:c1', '好文')]);
  const r = runner(db, p);

  await r.poll();
  await r.draftReplies();
  const queue = new ApprovalQueue(db, () => NOW);
  const a = queue.list('pending')[0]!;
  queue.approve(a.id);

  db.prepare(`UPDATE approvals SET payload = ? WHERE id = ?`).run(
    JSON.stringify({ ...(a.payload as any), body: '垃圾广告链接' }),
    a.id,
  );

  const res = await r.sendApproved();
  assert.equal(p.sink.replies.length, 0, 'a reply changed after approval must not go out');
  assert.match(res.failed[0]!.error, /payload changed/);
  assert.equal(queue.get(a.id)!.state, 'pending');
});

test('dry run reaches the provider but marks itself as such', async () => {
  const db = open(':memory:');
  seedPost(db);
  const p = fakeProvider('xiaohongshu', [comment('xiaohongshu:c1', '好文')]);
  const r = runner(db, p);

  await r.poll();
  await r.draftReplies();
  const queue = new ApprovalQueue(db, () => NOW);
  queue.approve(queue.list('pending')[0]!.id);

  await r.sendApproved({ dryRun: true });
  assert.equal(p.sink.replies[0]!.dryRun, true);
});

test('replyTargetFor encodes each platform addressing scheme', () => {
  assert.equal(
    replyTargetFor({ platform: 'xiaohongshu', id: 'xiaohongshu:c1', platform_post_id: 'note9' }),
    'note9/c1',
  );
  assert.equal(
    replyTargetFor({ platform: 'twitter', id: 'twitter:55', platform_post_id: '999' }),
    '55',
  );
});

test('the reply prompt forbids boilerplate and allows declining', () => {
  const p = buildReplyPrompt({ author: '读者', body: '怎么装？', platform: 'xiaohongshu' }, 'zh-CN');
  assert.match(p, /怎么装？/);
  assert.match(p, /SKIP/);
  assert.match(p, /感谢您的评论/, 'the prompt names the cliché it is banning');
  assert.match(p, /只输出回复正文/);
});
