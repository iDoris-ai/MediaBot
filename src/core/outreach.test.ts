import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_DAILY_LIMITS, OutreachRunner, buildOutreachPrompt } from './outreach';
import { EngagementRunner } from './engagement';
import { ApprovalQueue } from './approval';
import { open } from './db';
import type { EngagementProvider, SourceItem } from '../contracts';

const NOW = new Date('2026-07-24T12:00:00').getTime();

function provider(platform: string): EngagementProvider {
  return {
    info: { id: platform, slot: 'engagement', name: platform },
    platform,
    listComments: async () => [],
    reply: async () => ({ platformReplyId: 'r1', repliedAt: new Date(NOW) }),
  };
}

const target = (id: string, over: Partial<SourceItem> = {}): SourceItem => ({
  id: `xhs-search:${id}`,
  providerId: 'xhs-search',
  kind: 'trend',
  title: '一篇讲本地部署的帖子',
  summary: '作者用 3090 跑了一套本地推理',
  ...over,
});

function runner(
  clock = { t: NOW },
  draft: string | Error = '我们也试过类似的，显存占用主要卡在 KV cache。',
  random = () => 0,
) {
  const db = open(':memory:');
  const r = new OutreachRunner(db, {
    providers: [provider('xiaohongshu'), provider('twitter')],
    now: () => clock.t,
    random,
    claude: async () => {
      if (draft instanceof Error) throw draft;
      return { text: draft, transcript: '' };
    },
  });
  return { db, clock, r };
}

test('drafts an outbound comment and queues it for approval', async () => {
  const { db, r } = runner();
  const res = await r.propose([target('a')]);

  assert.equal(res.queued.length, 1);
  const pending = new ApprovalQueue(db, () => NOW).list('pending');
  assert.equal(pending.length, 1);
  assert.equal((pending[0]!.payload as any).outbound, true);
  assert.equal((pending[0]!.payload as any).platform, 'xiaohongshu');
});

test('nothing is posted during proposing', async () => {
  let replied = false;
  const db = open(':memory:');
  const p = { ...provider('xiaohongshu'), reply: async () => { replied = true; throw new Error('x'); } };
  const r = new OutreachRunner(db, {
    providers: [p as EngagementProvider],
    now: () => NOW,
    claude: async () => ({ text: '具体的补充', transcript: '' }),
  });

  await r.propose([target('a')]);
  assert.equal(replied, false, 'commenting on a stranger must pass the approval gate first');
});

test('the model declining is respected and common', async () => {
  const { db, r } = runner({ t: NOW }, 'SKIP');
  const res = await r.propose([target('a')]);

  assert.equal(res.queued.length, 0);
  assert.match(res.skipped[0]!.reason, /nothing specific/);
  assert.equal(new ApprovalQueue(db).list('pending').length, 0);
});

test('the daily cap is enforced from the database', async () => {
  const { r } = runner();
  const limit = DEFAULT_DAILY_LIMITS['xiaohongshu']!;

  for (let i = 0; i < limit; i += 1) r.recordSent('xiaohongshu', `prior-${i}`);
  assert.equal(r.remainingToday('xiaohongshu'), 0);

  const res = await r.propose([target('new')]);
  assert.equal(res.queued.length, 0);
  assert.match(res.skipped[0]!.reason, /daily limit/);
});

test('a comment sent through the engagement executor counts against the cap', async () => {
  // The regression: outbound comments are queued as kind='reply' and sent by
  // EngagementRunner, which used to record them as kind='reply' — a row the
  // outreach cap never queries. So the cap counted nothing and never throttled.
  const clock = { t: NOW };
  const db = open(':memory:');
  const p = provider('xiaohongshu');

  const outreach = new OutreachRunner(db, {
    providers: [p],
    now: () => clock.t,
    random: () => 0,
    claude: async () => ({ text: '显存主要卡在 KV cache。', transcript: '' }),
  });
  const engagement = new EngagementRunner(db, { providers: [p], now: () => clock.t });
  const queue = new ApprovalQueue(db, () => clock.t);

  const { queued } = await outreach.propose([target('a')]);
  assert.equal(queued.length, 1);
  assert.equal(outreach.sentToday('xiaohongshu'), 0, 'nothing sent yet');

  queue.approve(queued[0]!);
  const res = await engagement.sendApproved();
  assert.equal(res.sent.length, 1, 'the approved outbound comment goes out');

  // The cap must now see it — the whole point of the fix.
  assert.equal(outreach.sentToday('xiaohongshu'), 1);
  assert.equal(outreach.remainingToday('xiaohongshu'), DEFAULT_DAILY_LIMITS['xiaohongshu']! - 1);

  // And the same post is never commented on again, now that the send is on record.
  clock.t += 30 * 60_000;
  const again = await outreach.propose([target('a')]);
  assert.match(again.skipped[0]!.reason, /already commented/);
});

test('unapproved drafts count against the cap so a batch approval cannot exceed it', async () => {
  const clock = { t: NOW };
  const db = open(':memory:');
  const r = new OutreachRunner(db, {
    providers: [provider('reddit')],
    now: () => clock.t,
    minGapMs: 0,
    maxGapMs: 0,
    claude: async () => ({ text: '具体补充', transcript: '' }),
  });
  const cap = DEFAULT_DAILY_LIMITS['reddit']!; // 5

  // Queue exactly the cap's worth of drafts across several proposes; none sent.
  const targets = Array.from({ length: cap + 3 }, (_, i) =>
    target(`r${i}`, { id: `reddit:r${i}`, providerId: 'reddit' }),
  );
  let queued = 0;
  for (const t of targets) {
    queued += (await r.propose([t])).queued.length;
    clock.t += 1000;
  }

  assert.equal(queued, cap, 'queuing stops at the cap even before anything is approved');
  assert.equal(r.remainingToday('reddit'), 0);
  assert.equal(new ApprovalQueue(db).list('pending').length, cap);
});

test('the cap is per platform, not global', async () => {
  const { r } = runner();
  for (let i = 0; i < DEFAULT_DAILY_LIMITS['xiaohongshu']!; i += 1) r.recordSent('xiaohongshu', `p${i}`);

  assert.equal(r.remainingToday('xiaohongshu'), 0);
  assert.ok(r.remainingToday('twitter') > 0);
});

test('the cap resets the next day', async () => {
  const clock = { t: NOW };
  const { r } = runner(clock);
  for (let i = 0; i < DEFAULT_DAILY_LIMITS['xiaohongshu']!; i += 1) r.recordSent('xiaohongshu', `p${i}`);
  assert.equal(r.remainingToday('xiaohongshu'), 0);

  clock.t = NOW + 24 * 3600_000;
  assert.ok(r.remainingToday('xiaohongshu') > 0);
});

test('comments are spaced out, and the gap is randomised', async () => {
  const clock = { t: NOW };
  // random() = 1 puts the required gap at its maximum.
  const { r } = runner(clock, '具体的补充', () => 1);

  r.recordSent('xiaohongshu', 'earlier');
  clock.t += 60_000;

  const tooSoon = await r.propose([target('a')]);
  assert.match(tooSoon.skipped[0]!.reason, /too soon/);

  clock.t += 10 * 60_000;
  const later = await r.propose([target('b')]);
  assert.equal(later.queued.length, 1);
});

test('a fixed cadence is never produced — the gap varies with random()', async () => {
  const clock = { t: NOW };
  const values = [0, 1];
  let i = 0;
  const { r } = runner(clock, '补充', () => values[i++ % values.length]!);

  r.recordSent('xiaohongshu', 'earlier');
  clock.t += 4 * 60_000; // between min (3m) and max (7m)

  // random()=0 → 3m required → passes
  assert.equal((await r.propose([target('a')])).queued.length, 1);

  r.recordSent('xiaohongshu', 'a');
  clock.t += 4 * 60_000;
  // random()=1 → 7m required → blocked at the same elapsed time
  assert.match((await r.propose([target('b')])).skipped[0]!.reason, /too soon/);
});

test('the same post is never commented on twice', async () => {
  const clock = { t: NOW };
  const { r } = runner(clock);

  assert.equal((await r.propose([target('a')])).queued.length, 1);

  clock.t += 30 * 60_000;
  const again = await r.propose([target('a')]);
  assert.equal(again.queued.length, 0);
  assert.match(again.skipped[0]!.reason, /already commented/, 'a pending approval counts as engaged');
});

test('a post whose platform has no provider is skipped', async () => {
  const { r } = runner();
  const res = await r.propose([target('a', { id: 'rss:1', providerId: 'rss' })]);
  assert.match(res.skipped[0]!.reason, /unknown platform/);
});

test('a draft failure skips that target without losing the others', async () => {
  const clock = { t: NOW };
  const db = open(':memory:');
  let call = 0;
  const r = new OutreachRunner(db, {
    providers: [provider('xiaohongshu')],
    now: () => clock.t,
    random: () => 0,
    minGapMs: 0,
    maxGapMs: 0,
    claude: async () => {
      call += 1;
      if (call === 1) throw new Error('model unavailable');
      return { text: '具体补充', transcript: '' };
    },
  });

  const res = await r.propose([target('a'), target('b')]);
  assert.equal(res.queued.length, 1);
  assert.match(res.skipped[0]!.reason, /model unavailable/);
});

test('propose respects its own limit argument', async () => {
  const clock = { t: NOW };
  const db = open(':memory:');
  const r = new OutreachRunner(db, {
    providers: [provider('xiaohongshu')],
    now: () => clock.t,
    minGapMs: 0,
    maxGapMs: 0,
    claude: async () => ({ text: '补充', transcript: '' }),
  });

  const res = await r.propose([target('a'), target('b'), target('c')], 2);
  assert.equal(res.queued.length + res.skipped.length, 2);
});

test('default caps are conservative', () => {
  for (const [platform, cap] of Object.entries(DEFAULT_DAILY_LIMITS)) {
    assert.ok(cap <= 20, `${platform} cap of ${cap} is too aggressive for outbound commenting`);
  }
});

test('the prompt forbids self-promotion and clichés, and invites declining', () => {
  const p = buildOutreachPrompt(target('a'), 'zh-CN');

  assert.match(p, /本地部署/, 'the specific post is in the prompt');
  assert.match(p, /不准提自己的产品/);
  assert.match(p, /说得好/, 'names the clichés it bans');
  assert.match(p, /SKIP/);
  assert.match(p, /比不评论更糟/, 'explains why a generic comment is worse than silence');
});
