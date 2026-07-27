import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLATFORM_SHAPES, findDuplicates, shapeGuidance, similarity } from './platform-shapes';
import { ClaudeComposer, buildPrompt } from '../providers/composer/claude';
import type { ContentBrief } from '../contracts';

const brief = (platforms: string[]): ContentBrief => ({
  sources: [],
  targetPlatforms: platforms,
  locale: 'zh-CN',
  goal: '介绍本地跑大模型',
});

test('identical text scores 1, unrelated text scores low', () => {
  assert.equal(similarity('完全一样的文本内容', '完全一样的文本内容'), 1);
  assert.ok(similarity('今天讲本地大模型部署', '周末去清迈吃了顿好的') < 0.1);
});

test('similarity works on Chinese, where word tokenisation would not', () => {
  // Two entirely different Chinese sentences with no spaces. A word-token
  // measure would see one token each and call them identical.
  const a = '在自己电脑上跑大模型，数据不出本机';
  const b = '周末骑车去了郊外，天气很好';
  assert.ok(similarity(a, b) < 0.15, 'character trigrams distinguish these; word tokens would not');
});

test('formatting differences do not disguise identical prose', () => {
  const plain = '这是一段正文内容，讲的是本地部署。';
  const formatted = '**这是一段正文内容**，讲的是本地部署！！！\n\n';
  assert.ok(
    similarity(plain, formatted) > 0.9,
    'adding punctuation and markdown must not make a copy look original',
  );
});

test('a paraphrase still scores high enough to flag', () => {
  const a = '在自己电脑上跑大模型，数据完全不出本机，成本也低。';
  const b = '在自己电脑上跑大模型，数据完全不出本机，成本很低。';
  assert.ok(similarity(a, b) > 0.75);
});

test('genuinely different posts about the same subject are not flagged', () => {
  const xhs = '姐妹们！本地跑大模型真的香，我用 M1 跑了一周，电费都没多少 🔥 #AI #本地部署';
  const blog =
    '本文记录在 Apple Silicon 上部署量化模型的完整过程，包括环境准备、模型选择、' +
    '推理性能实测数据，以及与云端方案的成本对比分析。';
  assert.ok(
    similarity(xhs, blog) < 0.75,
    'the threshold must not punish two honest posts on one topic',
  );
});

test('findDuplicates reports the offending pair', () => {
  const dupes = findDuplicates([
    { platform: 'xiaohongshu', body: '本地跑大模型，数据不出本机，成本低。' },
    { platform: 'twitter', body: '本地跑大模型，数据不出本机，成本低。' },
    { platform: 'blog-tech', body: '完全不同的一段技术分析，讲的是量化推理的显存占用曲线。' },
  ]);

  assert.equal(dupes.length, 1);
  assert.deepEqual([dupes[0]!.a, dupes[0]!.b].sort(), ['twitter', 'xiaohongshu']);
  assert.ok(dupes[0]!.similarity > 0.9);
});

test('findDuplicates is quiet when every variant differs', () => {
  assert.deepEqual(
    findDuplicates([
      { platform: 'a', body: '第一段完全不同的内容讲的是甲' },
      { platform: 'b', body: 'totally different english text about something else' },
    ]),
    [],
  );
});

test('every configured platform declares a usable shape', () => {
  for (const [name, shape] of Object.entries(PLATFORM_SHAPES)) {
    assert.ok(shape.voice.length > 5, `${name} needs voice guidance`);
    assert.ok(shape.structure.length > 5, `${name} needs structure guidance`);
    assert.ok(
      shape.targetLength[0] < shape.targetLength[1],
      `${name} has an inverted length range`,
    );
  }
});

test('shapes differ meaningfully between platforms', () => {
  const xhs = PLATFORM_SHAPES['xiaohongshu']!;
  const blog = PLATFORM_SHAPES['blog-tech']!;
  assert.ok(
    blog.targetLength[0] > xhs.targetLength[1],
    'a technical blog post should start where a XHS post ends',
  );
  assert.notEqual(xhs.voice, blog.voice);
});

test('Reddit is told not to use hashtags', () => {
  assert.match(PLATFORM_SHAPES['reddit']!.tagging!, /不要 hashtag/);
});

test('an unknown platform still gets neutral guidance', () => {
  assert.match(shapeGuidance('some-new-platform'), /some-new-platform/);
});

test('the prompt carries each platform own shape', () => {
  const p = buildPrompt(brief(['xiaohongshu', 'blog-tech', 'twitter']));

  assert.match(p, /xiaohongshu:/);
  assert.match(p, /blog-tech:/);
  assert.match(p, /twitter:/);
  assert.match(p, /话题标签/, 'XHS tagging guidance is present');
  assert.match(p, /最多 1-2 个 hashtag/, 'X tagging guidance is present');
  assert.match(p, /read the same post twice/);
});

test('the composer reports near-identical variants instead of shipping them quietly', async () => {
  const copies = `\`\`\`json
{"variants":[
  {"platform":"xiaohongshu","body":"本地跑大模型，数据不出本机，成本也低。"},
  {"platform":"twitter","body":"本地跑大模型，数据不出本机，成本也低。"}
]}
\`\`\``;

  const found: Array<{ a: string; b: string; similarity: number }> = [];
  const c = new ClaudeComposer({
    runner: async () => ({ text: copies, transcript: '' }),
    onDuplicates: (d) => found.push(...d),
  });

  const draft = await c.compose(brief(['xiaohongshu', 'twitter']));

  assert.equal(draft.variants.length, 2, 'the draft is still produced');
  assert.equal(found.length, 1, 'but the duplication is surfaced');
  assert.ok(found[0]!.similarity > 0.9);
});

test('distinct variants raise no duplicate finding', async () => {
  const distinct = `\`\`\`json
{"variants":[
  {"platform":"xiaohongshu","body":"姐妹们！本地跑大模型真的香，我用 M1 跑了一周 🔥"},
  {"platform":"blog-tech","body":"本文记录在 Apple Silicon 上部署量化模型的完整过程与性能实测数据。"}
]}
\`\`\``;

  const found: unknown[] = [];
  const c = new ClaudeComposer({
    runner: async () => ({ text: distinct, transcript: '' }),
    onDuplicates: (d) => found.push(...d),
  });

  await c.compose(brief(['xiaohongshu', 'blog-tech']));
  assert.equal(found.length, 0);
});

test('the duplicate check can be switched off', async () => {
  const copies = `\`\`\`json
{"variants":[
  {"platform":"xiaohongshu","body":"一模一样的内容"},
  {"platform":"twitter","body":"一模一样的内容"}
]}
\`\`\``;

  const found: unknown[] = [];
  const c = new ClaudeComposer({
    runner: async () => ({ text: copies, transcript: '' }),
    duplicateThreshold: 1,
    onDuplicates: (d) => found.push(...d),
  });

  await c.compose(brief(['xiaohongshu', 'twitter']));
  assert.equal(found.length, 0);
});

test('a single variant is never compared against itself', async () => {
  const found: unknown[] = [];
  const c = new ClaudeComposer({
    runner: async () => ({
      text: '```json\n{"variants":[{"platform":"twitter","body":"only one"}]}\n```',
      transcript: '',
    }),
    onDuplicates: (d) => found.push(...d),
  });

  await c.compose(brief(['twitter']));
  assert.equal(found.length, 0);
});

test('hard limits are stated for platforms that enforce short fields', () => {
  // Found by the acceptance drill: without these the model writes a plausible
  // 30-character XHS title, validation rejects it, and that platform silently
  // gets nothing for a model call already paid for.
  for (const name of ['xiaohongshu', 'twitter', 'wechat-mp', 'wechat-channels']) {
    assert.ok(PLATFORM_SHAPES[name]!.hardLimits, `${name} must state its hard limits`);
  }
});

test('the X guidance warns that CJK counts double', () => {
  assert.match(
    PLATFORM_SHAPES['twitter']!.hardLimits!,
    /2 个单位/,
    '260 Chinese characters is ~520 weighted units and would be rejected',
  );
});

test('hard limits appear before tone in the guidance', () => {
  const g = shapeGuidance('xiaohongshu');
  assert.ok(
    g.indexOf('硬限制') < g.indexOf('语气'),
    'breaking a hard limit costs the whole variant; missing the tone only makes it worse',
  );
  assert.match(g, /标题最多 20 字/);
});
