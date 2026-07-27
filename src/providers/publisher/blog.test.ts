import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BLOG_SCHEMAS, BlogPublisher, renderMarkdown, slugify, type BlogPublisherOptions } from './blog';
import { runConformance } from '../../testing/conformance';
import { ProviderError, type DraftVariant } from '../../contracts';
import type { CliRunner } from '../../core/cli-adapter';

const NOW = new Date('2026-07-24T10:00:00');

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediabot-blog-'));
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src/content/blog'), { recursive: true });
  return dir;
}

function publisher(over: Partial<BlogPublisherOptions> = {}, calls: string[][] = []) {
  const runner: CliRunner = async (_bin, args) => {
    calls.push(args);
    return { stdout: '', stderr: '' };
  };
  return new BlogPublisher({
    platform: 'blog-tech',
    repo: repo(),
    contentDir: 'src/content/blog',
    schema: BLOG_SCHEMAS['blog']!,
    urlPattern: 'https://blog.example/blog/{slug}/',
    runner,
    now: () => NOW,
    ...over,
  });
}

const variant = (over: Partial<DraftVariant> = {}): DraftVariant => ({
  id: 'dv_1',
  platform: 'blog-tech',
  title: 'Local models on a laptop',
  body: 'This is the article body.\n\nWith a second paragraph.',
  media: [],
  meta: { frontmatter: { category: 'Tech-Experiment' } },
  ...over,
});

test('writes a markdown file with valid frontmatter and commits it', async () => {
  const calls: string[][] = [];
  const dir = repo();
  const p = publisher({ repo: dir }, calls);

  const res = await p.publish(variant(), { accountId: 'a' });

  const file = path.join(dir, 'src/content/blog/local-models-on-a-laptop.md');
  assert.ok(fs.existsSync(file));

  const content = fs.readFileSync(file, 'utf8');
  assert.match(content, /^---\n/);
  assert.match(content, /title: "Local models on a laptop"/);
  assert.match(content, /pubDate: "2026-07-24"/);
  assert.match(content, /category: "Tech-Experiment"/);
  assert.match(content, /This is the article body\./);

  assert.equal(res.platformPostId, 'local-models-on-a-laptop');
  assert.equal(res.url, 'https://blog.example/blog/local-models-on-a-laptop/');

  const gitCommands = calls.map((c) => c[2]);
  assert.deepEqual(gitCommands, ['add', 'commit', 'push']);
});

test('an out-of-enum category is rejected before it breaks the site build', async () => {
  const p = publisher();
  const res = await p.validate(
    variant({ meta: { frontmatter: { category: 'Not-A-Real-Category' } } }),
  );

  assert.equal(res.ok, false);
  const err = res.errors.find((e) => e.code === 'invalid_enum')!;
  assert.match(err.message, /site build would fail/);
  assert.match(err.message, /Tech-Experiment/, 'lists what is allowed');
});

test('each collection enforces its own category enum', async () => {
  const life = publisher({ platform: 'blog-life', schema: BLOG_SCHEMAS['my'] });

  // 'Thought' is valid in `my` but not in `blog`.
  assert.equal((await life.validate(variant({ meta: { frontmatter: { category: 'Thought' } } }))).ok, true);
  assert.equal(
    (await publisher().validate(variant({ meta: { frontmatter: { category: 'Thought' } } }))).ok,
    false,
  );
});

test('missing required frontmatter is caught', async () => {
  const p = publisher();
  const res = await p.validate(variant({ title: '', meta: { frontmatter: { category: 'Research' } } }));
  assert.ok(res.errors.some((e) => e.code === 'title_required'));
});

test('an existing slug is refused rather than overwriting a published article', async () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'src/content/blog/local-models-on-a-laptop.md'), 'existing');
  const p = publisher({ repo: dir });

  const res = await p.validate(variant());
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.code === 'slug_exists'));

  await assert.rejects(p.publish(variant(), { accountId: 'a' }), (err: unknown) => {
    assert.ok(err instanceof ProviderError);
    assert.match(err.message, /refusing to overwrite/);
    return true;
  });
  assert.equal(
    fs.readFileSync(path.join(dir, 'src/content/blog/local-models-on-a-laptop.md'), 'utf8'),
    'existing',
    'the published article must survive untouched',
  );
});

test('dry run writes nothing and runs no git command', async () => {
  const calls: string[][] = [];
  const dir = repo();
  const p = publisher({ repo: dir }, calls);

  const res = await p.publish(variant(), { accountId: 'a', dryRun: true });

  assert.equal(fs.readdirSync(path.join(dir, 'src/content/blog')).length, 0);
  assert.equal(calls.length, 0);
  assert.match(res.platformPostId, /^dryrun_/);
});

test('a git failure keeps the written article rather than discarding it', async () => {
  const dir = repo();
  const failing: CliRunner = async (_b, args) => {
    if (args.includes('push')) throw new Error('remote rejected');
    return { stdout: '', stderr: '' };
  };
  const p = publisher({ repo: dir, runner: failing });

  await assert.rejects(p.publish(variant(), { accountId: 'a' }), (err: unknown) => {
    assert.equal((err as ProviderError).retryable, true);
    assert.match((err as Error).message, /article written to/);
    return true;
  });
  assert.ok(
    fs.existsSync(path.join(dir, 'src/content/blog/local-models-on-a-laptop.md')),
    'deleting the article to tidy up would lose the content',
  );
});

test('commit and push can be disabled', async () => {
  const calls: string[][] = [];
  const dir = repo();
  const p = publisher({ repo: dir, commit: false }, calls);

  await p.publish(variant(), { accountId: 'a' });
  assert.equal(calls.length, 0);
  assert.ok(fs.existsSync(path.join(dir, 'src/content/blog/local-models-on-a-laptop.md')));
});

test('checkAuth reports a missing repo, missing .git and missing collection', async () => {
  assert.match((await publisher({ repo: '/nope' }).checkAuth()).reason!, /not found/);

  const noGit = fs.mkdtempSync(path.join(os.tmpdir(), 'mediabot-blog-'));
  fs.mkdirSync(path.join(noGit, 'src/content/blog'), { recursive: true });
  assert.match((await publisher({ repo: noGit }).checkAuth()).reason!, /not a git repository/);

  const noDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediabot-blog-'));
  fs.mkdirSync(path.join(noDir, '.git'), { recursive: true });
  assert.match((await publisher({ repo: noDir }).checkAuth()).reason!, /content directory not found/);

  assert.equal((await publisher().checkAuth()).ok, true);
});

test('an explicit slug overrides the title-derived one', async () => {
  const dir = repo();
  const p = publisher({ repo: dir });
  await p.publish(
    variant({ meta: { slug: 'custom-path', frontmatter: { category: 'Research' } } }),
    { accountId: 'a' },
  );
  assert.ok(fs.existsSync(path.join(dir, 'src/content/blog/custom-path.md')));
});

test('description falls back to the first real paragraph', async () => {
  const dir = repo();
  const p = publisher({ repo: dir });
  await p.publish(
    variant({
      body: '# A heading\n\n> a quote\n\nThe actual opening sentence.',
      meta: { frontmatter: { category: 'Research' } },
    }),
    { accountId: 'a' },
  );

  const content = fs.readFileSync(path.join(dir, 'src/content/blog/local-models-on-a-laptop.md'), 'utf8');
  assert.match(content, /description: "The actual opening sentence\."/, 'headings and quotes are skipped');
});

test('supplied frontmatter wins over defaults', async () => {
  const dir = repo();
  const p = publisher({ repo: dir });
  await p.publish(
    variant({ meta: { frontmatter: { category: 'Tech-News', tags: ['a', 'b'], titleEn: 'English' } } }),
    { accountId: 'a' },
  );

  const content = fs.readFileSync(path.join(dir, 'src/content/blog/local-models-on-a-laptop.md'), 'utf8');
  assert.match(content, /category: "Tech-News"/);
  assert.match(content, /tags: \["a", "b"\]/);
  assert.match(content, /titleEn: "English"/);
});

test('slugify handles CJK, punctuation and length', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world');
  assert.equal(slugify('  Spaced   Out  '), 'spaced-out');
  assert.equal(slugify('在笔记本上跑大模型'), '在笔记本上跑大模型', 'a CJK slug is valid and readable in a URL');
  assert.ok(slugify('x'.repeat(200)).length <= 80);
});

test('renderMarkdown escapes values that would break YAML', () => {
  const md = renderMarkdown({ title: 'He said: "hi"', tags: ['a'], n: 3, ok: true }, 'body');
  assert.match(md, /title: "He said: \\"hi\\""/);
  assert.match(md, /tags: \["a"\]/);
  assert.match(md, /n: 3/);
  assert.match(md, /ok: true/);
});

test('renderMarkdown drops keys that could inject YAML', () => {
  // A composer-supplied key with a newline would otherwise open a new line or
  // close the frontmatter block — a vector the human gate can't see, since the
  // approval UI shows only title + body.
  const md = renderMarkdown(
    { title: 'ok', 'category\npublished: true': 'x', '---\ninjected': 'y', tags: ['a'] },
    'body',
  );
  assert.match(md, /title: "ok"/);
  assert.match(md, /tags: \["a"\]/);
  assert.ok(!md.includes('published: true'), 'the smuggled YAML line must not appear');
  assert.ok(!md.includes('injected'), 'a key that closes the block must be dropped');
  // Exactly one frontmatter block: opening and closing fence only.
  assert.equal(md.match(/^---$/gm)!.length, 2);
});

test('passes the publisher conformance suite', async () => {
  const p = publisher();
  const report = await runConformance(p, 'publisher');
  // The probe variant has no category, which this collection legitimately
  // requires; every other check must pass.
  const relevant = report.checks.filter((c) => !/validate accepts a compliant variant/.test(c.name));
  assert.ok(
    relevant.every((c) => c.ok),
    relevant.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('\n'),
  );
});
