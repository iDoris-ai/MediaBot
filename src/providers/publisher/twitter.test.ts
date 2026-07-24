import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TwitterPublisher, weightedLength } from './twitter';
import { TwitterEngagement } from '../engagement/twitter';
import { runConformance } from '../../testing/conformance';
import { ProviderError, type DraftVariant } from '../../contracts';
import type { CliRunner } from '../../core/cli-adapter';

/** All tests use a stub runner — nothing here may post to the real account. */
function stubRunner(responses: Record<string, unknown>, calls: string[][] = []): CliRunner {
  return async (_bin, args) => {
    calls.push(args);
    const cmd = args[0]!;
    if (!(cmd in responses)) throw new Error(`unexpected twitter command: ${cmd}`);
    return { stdout: JSON.stringify(responses[cmd]), stderr: '' };
  };
}

function image(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediabot-tw-'));
  const p = path.join(dir, 'pic.png');
  fs.writeFileSync(p, 'x');
  return p;
}

function variant(over: Partial<DraftVariant> = {}): DraftVariant {
  return { id: 'dv_1', platform: 'twitter', body: 'hello world', media: [], ...over };
}

const OK_STATUS = { ok: true, data: { authenticated: true, user: { screenName: 'jhfnetboy' } } };
const OK_POST = { ok: true, data: { id: '1234567890', screenName: 'jhfnetboy' } };

test('checkAuth reflects twitter login state', async () => {
  const p = new TwitterPublisher({ runner: stubRunner({ status: OK_STATUS }) });
  assert.deepEqual(await p.checkAuth(), { ok: true });

  const anon = new TwitterPublisher({
    runner: stubRunner({ status: { ok: true, data: { authenticated: false } } }),
  });
  assert.match((await anon.checkAuth()).reason!, /twitter login/);
});

test('accepts a normal tweet', async () => {
  const p = new TwitterPublisher({ runner: stubRunner({}) });
  assert.equal((await p.validate(variant())).ok, true);
});

test('CJK counts double, matching X weighted length', () => {
  assert.equal(weightedLength('abc'), 3);
  assert.equal(weightedLength('中文'), 4);
  assert.equal(weightedLength('a中'), 3);
  assert.equal(weightedLength('🙂'), 1, 'emoji outside the wide ranges stay single-weight');
});

test('rejects a CJK body that fits .length but exceeds the weighted limit', async () => {
  const p = new TwitterPublisher({ runner: stubRunner({}) });
  const body = '中'.repeat(150); // .length 150 (looks fine) but weighs 300

  assert.ok(body.length <= 280, 'precondition: naive length check would pass');
  const res = await p.validate(variant({ body }));
  assert.equal(res.ok, false, 'weighted counting must catch what .length misses');
  assert.equal(res.errors[0]!.code, 'text_too_long');
});

test('rejects empty body and too many images', async () => {
  const p = new TwitterPublisher({ runner: stubRunner({}) });
  const codes = async (v: DraftVariant) => (await p.validate(v)).errors.map((e) => e.code);

  assert.deepEqual(await codes(variant({ body: '   ' })), ['empty_body']);
  const five = Array.from({ length: 5 }, () => ({ kind: 'image' as const, path: image() }));
  assert.deepEqual(await codes(variant({ media: five })), ['too_many_images']);
});

test('warns that title and video are dropped', async () => {
  const p = new TwitterPublisher({ runner: stubRunner({}) });
  const res = await p.validate(variant({ title: 'ignored', media: [{ kind: 'video', path: '/tmp/v.mp4' }] }));
  assert.equal(res.ok, true);
  assert.deepEqual(res.warnings.map((w) => w.code).sort(), ['title_ignored', 'video_ignored']);
});

test('publish builds the post command and returns the tweet id and url', async () => {
  const calls: string[][] = [];
  const p = new TwitterPublisher({ runner: stubRunner({ post: OK_POST }, calls) });
  const img = image();

  const res = await p.publish(variant({ media: [{ kind: 'image', path: img }] }), { accountId: 'acc' });

  assert.equal(res.platformPostId, '1234567890');
  assert.equal(res.url, 'https://x.com/jhfnetboy/status/1234567890');

  const args = calls[0]!;
  assert.equal(args[0], 'post');
  assert.equal(args[1], 'hello world', 'tweet text is a positional argument');
  assert.equal(args[args.indexOf('--image') + 1], img);
});

test('dry run never reaches the platform', async () => {
  const calls: string[][] = [];
  const p = new TwitterPublisher({ runner: stubRunner({ post: OK_POST }, calls) });
  const res = await p.publish(variant(), { accountId: 'acc', dryRun: true });

  assert.equal(calls.length, 0, 'posting is irreversible; a dry run must not call the CLI');
  assert.match(res.platformPostId, /^dryrun_/);
});

test('missing tweet id raises a ProviderError', async () => {
  const p = new TwitterPublisher({ runner: stubRunner({ post: { ok: false, error: 'duplicate' } }) });
  await assert.rejects(p.publish(variant(), { accountId: 'acc' }), ProviderError);
});

test('passes the publisher conformance suite', async () => {
  const p = new TwitterPublisher({ runner: stubRunner({ status: OK_STATUS, post: OK_POST }) });
  const report = await runConformance(p, 'publisher');
  assert.ok(report.passed, report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('\n'));
});

test('engagement: replies are namespaced and time-filtered', async () => {
  const e = new TwitterEngagement({
    runner: stubRunner({
      tweet: {
        data: {
          replies: [
            { id_str: '11', full_text: 'nice', created_at: '2026-07-01T00:00:00Z', user: { screenName: 'a' } },
            { id_str: '22', full_text: 'later', created_at: '2026-07-10T00:00:00Z', user: { screenName: 'b' } },
          ],
        },
      },
    }),
  });

  const all = await e.listComments({ postId: 'p1', platformPostId: '999', accountId: 'acc' });
  assert.deepEqual(all.map((c) => c.id), ['twitter:11', 'twitter:22']);
  assert.equal(all[0]!.author, 'a');

  const recent = await e.listComments(
    { postId: 'p1', platformPostId: '999', accountId: 'acc' },
    new Date('2026-07-05T00:00:00Z'),
  );
  assert.deepEqual(recent.map((c) => c.id), ['twitter:22']);
});

test('engagement: reply strips the platform prefix and posts to the tweet', async () => {
  const calls: string[][] = [];
  const e = new TwitterEngagement({
    runner: stubRunner({ reply: { ok: true, data: { id: '555' } } }, calls),
  });
  const res = await e.reply('twitter:11', 'thanks!', { accountId: 'acc' });

  assert.equal(res.platformReplyId, '555');
  assert.deepEqual(calls[0]!.slice(0, 3), ['reply', '11', 'thanks!']);
});

test('engagement: dry-run reply does not call the CLI', async () => {
  const calls: string[][] = [];
  const e = new TwitterEngagement({ runner: stubRunner({ reply: {} }, calls) });
  await e.reply('twitter:11', 'hi', { accountId: 'acc', dryRun: true });
  assert.equal(calls.length, 0);
});

test('passes the engagement conformance suite', async () => {
  const e = new TwitterEngagement({ runner: stubRunner({ tweet: { data: { replies: [] } } }) });
  const report = await runConformance(e, 'engagement');
  assert.ok(report.passed, report.checks.filter((c) => !c.ok).map((c) => c.detail).join('\n'));
});
