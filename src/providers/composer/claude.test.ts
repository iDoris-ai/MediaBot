import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeComposer, buildPrompt, parseVariants, parseDelimitedVariants } from './claude';
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

const GOOD = `<<<VARIANT platform=xiaohongshu>>>
TITLE: 标题
TAGS: a
BODY:
小红书正文
<<<END>>>

<<<VARIANT platform=linkedin>>>
BODY:
LinkedIn body
<<<END>>>`;

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

test('parses the delimiter format, including bodies with code fences', () => {
  // The real failure this format exists to avoid: JSON requires escaping every
  // newline in a long body, and the model got that wrong about a third of the
  // time. Here nothing needs escaping.
  const output = `<<<VARIANT platform=blog-tech>>>
TITLE: 在 Mac 上跑本地模型
TAGS: 本地部署, Ollama
BODY:
先查内存上限：

\`\`\`bash
sysctl iogpu.wired_limit_mb
\`\`\`

然后重启即可。
<<<END>>>

<<<VARIANT platform=twitter>>>
BODY:
决定性因素是内存，不是芯片型号。
<<<END>>>`;

  const parsed = parseVariants(output)!;
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]!.platform, 'blog-tech');
  assert.equal(parsed[0]!.title, '在 Mac 上跑本地模型');
  assert.deepEqual((parsed[0]!.meta as any).tags, ['本地部署', 'Ollama']);
  assert.match(parsed[0]!.body!, /sysctl iogpu/, 'code fences inside the body survive');
  assert.match(parsed[0]!.body!, /然后重启即可。$/, 'the body is not truncated at the inner fence');
  assert.equal(parsed[1]!.title, undefined, 'TITLE is optional');
});

test('a body containing real newlines needs no escaping', () => {
  const parsed = parseVariants(`<<<VARIANT platform=x>>>
BODY:
第一段。

第二段，带"引号"和 \\ 反斜杠。
<<<END>>>`)!;
  assert.match(parsed[0]!.body!, /第一段。\n\n第二段/);
  assert.match(parsed[0]!.body!, /"引号"/);
});

test('a block with no BODY marker is skipped rather than half-parsed', () => {
  assert.deepEqual(parseDelimitedVariants('<<<VARIANT platform=x>>>\nTITLE: only a title\n<<<END>>>'), []);
});

test('JSON output is still accepted as a fallback', () => {
  const parsed = parseVariants('```json\n{"variants":[{"platform":"twitter","body":"short"}]}\n```')!;
  assert.equal(parsed[0]!.platform, 'twitter');
});

test('output in neither format yields null', () => {
  assert.equal(parseVariants('I could not do that, sorry.'), null);
});

test('tags accept both ASCII and full-width commas', () => {
  const parsed = parseVariants('<<<VARIANT platform=x>>>\nTAGS: #一, 二，三\nBODY:\nb\n<<<END>>>')!;
  assert.deepEqual((parsed[0]!.meta as any).tags, ['一', '二', '三']);
});
