import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BilibiliPublisher } from './bilibili';
import { runConformance } from '../../testing/conformance';
import { ProviderError, type DraftVariant } from '../../contracts';
import type { CliRunner } from '../../core/cli-adapter';

function stubRunner(responses: Record<string, unknown>, calls: string[][] = []): CliRunner {
  return async (_bin, args) => {
    calls.push(args);
    const cmd = args[0]!;
    if (!(cmd in responses)) throw new Error(`unexpected bili command: ${cmd}`);
    return { stdout: JSON.stringify(responses[cmd]), stderr: '' };
  };
}

const variant = (over: Partial<DraftVariant> = {}): DraftVariant => ({
  id: 'dv_1',
  platform: 'bilibili',
  body: '今天的进展',
  media: [],
  ...over,
});

const OK_STATUS = { ok: true, data: { authenticated: true, user: { name: '嗷嗷的吃馒头' } } };
const OK_POST = { ok: true, data: { dynamic_id: '998877' } };

test('checkAuth reflects bili login state', async () => {
  const p = new BilibiliPublisher({ runner: stubRunner({ status: OK_STATUS }) });
  assert.deepEqual(await p.checkAuth(), { ok: true });
});

test('declares no video support, matching what the CLI can actually do', async () => {
  const p = new BilibiliPublisher({ runner: stubRunner({}) });
  assert.equal(p.limits.video, undefined, 'video submission has no CLI path; do not claim it');
});

test('rejects empty and over-long bodies', async () => {
  const p = new BilibiliPublisher({ runner: stubRunner({}) });
  const codes = async (v: DraftVariant) => (await p.validate(v)).errors.map((e) => e.code);
  assert.deepEqual(await codes(variant({ body: '  ' })), ['empty_body']);
  assert.deepEqual(await codes(variant({ body: 'x'.repeat(1001) })), ['text_too_long']);
});

test('warns that media is dropped and title is folded in', async () => {
  const p = new BilibiliPublisher({ runner: stubRunner({}) });
  const res = await p.validate(variant({ title: 'T', media: [{ kind: 'image', path: '/tmp/a.png' }] }));
  assert.equal(res.ok, true);
  assert.deepEqual(res.warnings.map((w) => w.code).sort(), ['media_ignored', 'title_ignored']);
});

test('a title becomes the first line rather than being discarded', async () => {
  const calls: string[][] = [];
  const p = new BilibiliPublisher({ runner: stubRunner({ 'dynamic-post': OK_POST }, calls) });
  await p.publish(variant({ title: '标题' }), { accountId: 'acc' });
  assert.equal(calls[0]![1], '标题\n\n今天的进展');
});

test('publish returns the dynamic id and url', async () => {
  const p = new BilibiliPublisher({ runner: stubRunner({ 'dynamic-post': OK_POST }) });
  const res = await p.publish(variant(), { accountId: 'acc' });
  assert.equal(res.platformPostId, '998877');
  assert.equal(res.url, 'https://t.bilibili.com/998877');
});

test('dry run does not call the CLI', async () => {
  const calls: string[][] = [];
  const p = new BilibiliPublisher({ runner: stubRunner({ 'dynamic-post': OK_POST }, calls) });
  await p.publish(variant(), { accountId: 'acc', dryRun: true });
  assert.equal(calls.length, 0);
});

test('a missing dynamic id raises a ProviderError', async () => {
  const p = new BilibiliPublisher({ runner: stubRunner({ 'dynamic-post': { ok: false } }) });
  await assert.rejects(p.publish(variant(), { accountId: 'acc' }), ProviderError);
});

test('passes the publisher conformance suite', async () => {
  const p = new BilibiliPublisher({ runner: stubRunner({ status: OK_STATUS, 'dynamic-post': OK_POST }) });
  const report = await runConformance(p, 'publisher');
  assert.ok(report.passed, report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('\n'));
});
