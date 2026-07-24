import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeComposer, buildPrompt } from './claude';
import { runConformance } from '../../testing/conformance';
import { ProviderError } from '../../contracts';
import type { ContentBrief } from '../../contracts';

function stub(text: string) {
  return async () => ({ text, transcript: '' });
}

const brief = (over: Partial<ContentBrief> = {}): ContentBrief => ({
  sources: [],
  targetPlatforms: ['xiaohongshu', 'linkedin'],
  locale: 'zh-CN',
  ...over,
});

const GOOD = `Here you go:
\`\`\`json
{"variants":[
  {"platform":"xiaohongshu","title":"标题","body":"小红书正文","meta":{"tags":["a"]}},
  {"platform":"linkedin","body":"LinkedIn body"}
]}
\`\`\`
Hope that helps!`;

test('parses variants out of a fenced block wrapped in prose', async () => {
  const c = new ClaudeComposer({ runner: stub(GOOD) });
  const draft = await c.compose(brief());

  assert.equal(draft.variants.length, 2);
  const xhs = draft.variants.find((v) => v.platform === 'xiaohongshu')!;
  assert.equal(xhs.title, '标题');
  assert.equal(xhs.body, '小红书正文');
  assert.deepEqual(xhs.meta, { tags: ['a'] });
  assert.deepEqual(xhs.media, []);
  assert.ok(draft.variants.every((v) => v.id.startsWith('dv_')));
});

test('drops variants for platforms that were not requested', async () => {
  const sneaky = `\`\`\`json
{"variants":[
  {"platform":"xiaohongshu","body":"ok"},
  {"platform":"twitter","body":"never asked for this"}
]}
\`\`\``;
  const draft = await new ClaudeComposer({ runner: stub(sneaky) }).compose(
    brief({ targetPlatforms: ['xiaohongshu'] }),
  );
  assert.deepEqual(draft.variants.map((v) => v.platform), ['xiaohongshu']);
});

test('keeps only the first variant per platform', async () => {
  const dupes = `\`\`\`json
{"variants":[
  {"platform":"xiaohongshu","body":"first"},
  {"platform":"xiaohongshu","body":"second"}
]}
\`\`\``;
  const draft = await new ClaudeComposer({ runner: stub(dupes) }).compose(
    brief({ targetPlatforms: ['xiaohongshu'] }),
  );
  assert.equal(draft.variants.length, 1);
  assert.equal(draft.variants[0]!.body, 'first');
});

test('skips variants with an empty body', async () => {
  const partial = `\`\`\`json
{"variants":[
  {"platform":"xiaohongshu","body":"   "},
  {"platform":"linkedin","body":"real content"}
]}
\`\`\``;
  const draft = await new ClaudeComposer({ runner: stub(partial) }).compose(brief());
  assert.deepEqual(draft.variants.map((v) => v.platform), ['linkedin']);
});

test('throws a non-retryable ProviderError when output has no JSON block', async () => {
  const c = new ClaudeComposer({ runner: stub('I could not do that, sorry.') });
  await assert.rejects(c.compose(brief()), (err: unknown) => {
    assert.ok(err instanceof ProviderError);
    assert.equal(err.retryable, false, 'a bad completion must not be retried — it just burns tokens');
    return true;
  });
});

test('throws when JSON is present but malformed', async () => {
  const c = new ClaudeComposer({ runner: stub('```json\n{"variants": [ broken\n```') });
  await assert.rejects(c.compose(brief()), ProviderError);
});

test('throws when no variant matches any requested platform', async () => {
  const c = new ClaudeComposer({ runner: stub('```json\n{"variants":[{"platform":"nope","body":"x"}]}\n```') });
  await assert.rejects(c.compose(brief()), /no usable variant/);
});

test('carries brief assets onto every variant', async () => {
  const c = new ClaudeComposer({ runner: stub(GOOD) });
  const draft = await c.compose(
    brief({ assets: [{ kind: 'image', path: '/tmp/a.png' }] }),
  );
  assert.ok(draft.variants.every((v) => v.media.length === 1 && v.media[0]!.path === '/tmp/a.png'));
});

test('returns an empty draft when no platforms are targeted', async () => {
  let called = false;
  const c = new ClaudeComposer({
    runner: async () => {
      called = true;
      return { text: GOOD, transcript: '' };
    },
  });
  const draft = await c.compose(brief({ targetPlatforms: [] }));
  assert.deepEqual(draft.variants, []);
  assert.equal(called, false, 'must not spend a model call when there is nothing to write for');
});

test('prompt names every target platform and asks for distinct variants', () => {
  const p = buildPrompt(brief({ goal: 'grow signups', sources: [
    { id: 'rss:1', providerId: 'rss', kind: 'news', title: 'Something happened', url: 'https://e.com' },
  ] }));
  assert.match(p, /xiaohongshu/);
  assert.match(p, /linkedin/);
  assert.match(p, /grow signups/);
  assert.match(p, /Something happened/);
  assert.match(p, /distinct variant per platform/);
});

test('passes the composer conformance suite', async () => {
  // The probe brief targets 'conformance-probe'; echo one variant back for it.
  const c = new ClaudeComposer({
    runner: stub('```json\n{"variants":[{"platform":"conformance-probe","body":"probe"}]}\n```'),
  });
  const report = await runConformance(c, 'composer');
  assert.ok(
    report.passed,
    report.checks.filter((x) => !x.ok).map((x) => `${x.name}: ${x.detail}`).join('\n'),
  );
});
