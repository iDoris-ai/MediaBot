import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { XiaohongshuPublisher } from './xiaohongshu';
import { XiaohongshuEngagement, splitCommentRef } from '../engagement/xiaohongshu';
import { runConformance } from '../../testing/conformance';
import { ProviderError } from '../../contracts';
import type { CliRunner } from '../../core/cli-adapter';
import type { DraftVariant } from '../../contracts';

/**
 * Every test drives a stub runner. Nothing here may reach the real xhs API —
 * publishing to a live account from a test suite would be unrecoverable.
 */
function stubRunner(responses: Record<string, unknown>, calls: string[][] = []): CliRunner {
  return async (_bin, args) => {
    calls.push(args);
    const cmd = args[0]!;
    if (!(cmd in responses)) throw new Error(`unexpected xhs command: ${cmd}`);
    return { stdout: JSON.stringify(responses[cmd]), stderr: '' };
  };
}

function image(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediabot-xhs-'));
  const p = path.join(dir, 'cover.png');
  fs.writeFileSync(p, 'not-really-a-png');
  return p;
}

function variant(over: Partial<DraftVariant> = {}): DraftVariant {
  return {
    id: 'dv_1',
    platform: 'xiaohongshu',
    title: '标题',
    body: '正文内容',
    media: [{ kind: 'image', path: image() }],
    ...over,
  };
}

const OK_STATUS = { ok: true, data: { authenticated: true, user: { name: 'Tester' } } };
const OK_POST = { ok: true, data: { note_id: 'note123', url: 'https://xhs/note123' } };

test('checkAuth reflects xhs login state', async () => {
  const authed = new XiaohongshuPublisher({ runner: stubRunner({ status: OK_STATUS }) });
  assert.deepEqual(await authed.checkAuth(), { ok: true });

  const anon = new XiaohongshuPublisher({
    runner: stubRunner({ status: { ok: true, data: { authenticated: false } } }),
  });
  const state = await anon.checkAuth();
  assert.equal(state.ok, false);
  assert.match(state.reason!, /xhs login/);
});

test('checkAuth reports missing binary instead of throwing', async () => {
  const p = new XiaohongshuPublisher({ bin: '/nonexistent/xhs' });
  const state = await p.checkAuth();
  assert.equal(state.ok, false);
  assert.match(state.reason!, /command not found/);
});

test('accepts a compliant note', async () => {
  const p = new XiaohongshuPublisher({ runner: stubRunner({}) });
  assert.equal((await p.validate(variant())).ok, true);
});

test('enforces XHS-specific rules: title required, 20-char title, 1000-char body, image required', async () => {
  const p = new XiaohongshuPublisher({ runner: stubRunner({}) });

  const codes = async (v: DraftVariant) => (await p.validate(v)).errors.map((e) => e.code);

  assert.deepEqual(await codes(variant({ title: '' })), ['title_required']);
  assert.deepEqual(await codes(variant({ title: 'x'.repeat(21) })), ['title_too_long']);
  assert.deepEqual(await codes(variant({ body: 'x'.repeat(1001) })), ['text_too_long']);
  assert.deepEqual(await codes(variant({ media: [] })), ['image_required']);
});

test('rejects missing or relative image paths', async () => {
  const p = new XiaohongshuPublisher({ runner: stubRunner({}) });

  const missing = await p.validate(variant({ media: [{ kind: 'image', path: '/tmp/definitely-absent.png' }] }));
  assert.deepEqual(missing.errors.map((e) => e.code), ['image_missing']);

  const relative = await p.validate(variant({ media: [{ kind: 'image', path: 'relative.png' }] }));
  assert.deepEqual(relative.errors.map((e) => e.code), ['image_path_not_absolute']);
});

test('warns that video attachments are ignored', async () => {
  const p = new XiaohongshuPublisher({ runner: stubRunner({}) });
  const res = await p.validate(
    variant({ media: [{ kind: 'image', path: image() }, { kind: 'video', path: '/tmp/v.mp4' }] }),
  );
  assert.equal(res.ok, true);
  assert.deepEqual(res.warnings.map((w) => w.code), ['video_ignored']);
});

test('publish builds the xhs post command and returns the note id', async () => {
  const calls: string[][] = [];
  const p = new XiaohongshuPublisher({ runner: stubRunner({ post: OK_POST }, calls) });
  const v = variant({ meta: { tags: ['#清迈', '其他'] } });

  const res = await p.publish(v, { accountId: 'acc_1' });

  assert.equal(res.platformPostId, 'note123');
  assert.equal(res.url, 'https://xhs/note123');

  const args = calls[0]!;
  assert.equal(args[0], 'post');
  assert.equal(args[args.indexOf('--title') + 1], '标题');
  assert.equal(args[args.indexOf('--body') + 1], '正文内容');
  assert.equal(args[args.indexOf('--images') + 1], v.media[0]!.path);
  assert.equal(args[args.indexOf('--topic') + 1], '清迈', 'leading # is stripped for --topic');
  assert.ok(args.includes('--json'));
  assert.ok(!args.includes('--private'), 'must not silently publish privately');
});

test('dry run never invokes the real post command', async () => {
  const calls: string[][] = [];
  const p = new XiaohongshuPublisher({ runner: stubRunner({ post: OK_POST }, calls) });

  const res = await p.publish(variant(), { accountId: 'acc_1', dryRun: true });

  assert.equal(calls.length, 0, 'a dry run must not reach the platform — publishing is irreversible');
  assert.match(res.platformPostId, /^dryrun_/);
});

test('publish surfaces a missing note id as a ProviderError', async () => {
  const p = new XiaohongshuPublisher({ runner: stubRunner({ post: { ok: false, error: 'blocked' } }) });
  await assert.rejects(p.publish(variant(), { accountId: 'acc_1' }), ProviderError);
});

test('login failures are classified as auth_expired and not retried', async () => {
  const runner: CliRunner = async () => {
    throw new ProviderError('xhs exited with an error: 请先登录', 'auth_expired', false);
  };
  const p = new XiaohongshuPublisher({ runner });
  await assert.rejects(p.publish(variant(), { accountId: 'acc_1' }), (err: unknown) => {
    assert.ok(err instanceof ProviderError);
    assert.equal(err.code, 'auth_expired');
    assert.equal(err.retryable, false, 'a re-login is needed; retrying would just fail again');
    return true;
  });
});

test('passes the publisher conformance suite', async () => {
  const p = new XiaohongshuPublisher({ runner: stubRunner({ status: OK_STATUS, post: OK_POST }) });
  const report = await runConformance(p, 'publisher');
  // The probe variant has no image, which XHS legitimately rejects; ignore only
  // that check and require everything else to pass.
  const relevant = report.checks.filter((c) => !/validate accepts a compliant variant/.test(c.name));
  assert.ok(
    relevant.every((c) => c.ok),
    relevant.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('\n'),
  );
});

test('engagement: listComments namespaces ids and converts timestamps', async () => {
  const e = new XiaohongshuEngagement({
    runner: stubRunner({
      comments: {
        data: {
          comments: [
            { comment_id: 'c1', content: '很棒', create_time: 1_780_000_000, user: { nickname: '读者' } },
            { comment_id: 'c2', content: '同意', create_time: 1_790_000_000, target_comment_id: 'c1' },
          ],
        },
      },
    }),
  });

  const comments = await e.listComments({ postId: 'post_1', platformPostId: 'note123', accountId: 'acc_1' });

  assert.deepEqual(comments.map((c) => c.id), ['xiaohongshu:c1', 'xiaohongshu:c2']);
  assert.equal(comments[0]!.author, '读者');
  assert.equal(comments[0]!.publishedAt!.getTime(), 1_780_000_000_000);
  assert.equal(comments[1]!.parentId, 'xiaohongshu:c1');
});

test('engagement: listComments filters by since', async () => {
  const e = new XiaohongshuEngagement({
    runner: stubRunner({
      comments: {
        data: {
          comments: [
            { comment_id: 'old', content: 'a', create_time: 1_700_000_000 },
            { comment_id: 'new', content: 'b', create_time: 1_800_000_000 },
          ],
        },
      },
    }),
  });
  const comments = await e.listComments(
    { postId: 'p', platformPostId: 'n', accountId: 'a' },
    new Date(1_750_000_000_000),
  );
  assert.deepEqual(comments.map((c) => c.id), ['xiaohongshu:new']);
});

test('engagement: dry-run reply does not call the CLI', async () => {
  const calls: string[][] = [];
  const e = new XiaohongshuEngagement({ runner: stubRunner({ reply: {} }, calls) });
  await e.reply('note123/c1', 'thanks', { accountId: 'acc_1', dryRun: true });
  assert.equal(calls.length, 0);
});

test('engagement: reply targets both note and comment', async () => {
  const calls: string[][] = [];
  const e = new XiaohongshuEngagement({
    runner: stubRunner({ reply: { ok: true, data: { comment_id: 'r1' } } }, calls),
  });
  const res = await e.reply('xiaohongshu:note123/c1', '谢谢！', { accountId: 'acc_1' });

  assert.equal(res.platformReplyId, 'r1');
  const args = calls[0]!;
  assert.equal(args[1], 'note123');
  assert.equal(args[args.indexOf('--comment-id') + 1], 'c1');
  assert.equal(args[args.indexOf('-c') + 1], '谢谢！');
});

test('splitCommentRef rejects a ref without a note id', () => {
  assert.throws(() => splitCommentRef('c1'), ProviderError);
  assert.deepEqual(splitCommentRef('note1/c1'), { noteId: 'note1', externalCommentId: 'c1' });
});

test('passes the engagement conformance suite', async () => {
  const e = new XiaohongshuEngagement({ runner: stubRunner({ comments: { data: { comments: [] } } }) });
  const report = await runConformance(e, 'engagement');
  assert.ok(report.passed, report.checks.filter((c) => !c.ok).map((c) => c.detail).join('\n'));
});
