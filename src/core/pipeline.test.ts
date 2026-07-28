import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { open } from './db';
import { Pipeline } from './pipeline';
import { ClaudeComposer } from '../providers/composer/claude';
import { DryRunPublisher } from '../providers/publisher/dryrun';
import { RssSourceProvider } from '../providers/source/rss';
import { ProviderError, type SourceProvider } from '../contracts';

const FEED = `<rss><channel>
  <item><title>Alpha release</title><guid>g-1</guid><link>https://e.com/1</link>
        <pubDate>Tue, 01 Jul 2026 10:00:00 GMT</pubDate></item>
  <item><title>Beta release</title><guid>g-2</guid><link>https://e.com/2</link>
        <pubDate>Wed, 02 Jul 2026 10:00:00 GMT</pubDate></item>
</channel></rss>`;

// The delimiter format the composer now asks for.
const COMPOSED = `<<<VARIANT platform=dryrun>>>
TITLE: Title
TAGS: x
BODY:
Composed body
<<<END>>>`;

function outDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mediabot-pipe-'));
}

function build(over: { composerText?: string; sources?: SourceProvider[] } = {}) {
  const db = open(':memory:');
  const dir = outDir();
  const publisher = new DryRunPublisher({ outDir: dir });
  const pipeline = new Pipeline(db, {
    sources: over.sources ?? [
      new RssSourceProvider({
        feeds: ['https://e.com/feed'],
        fetchImpl: (async () => new Response(FEED, { status: 200 })) as unknown as typeof fetch,
      }),
    ],
    composer: new ClaudeComposer({
      runner: async () => ({ text: over.composerText ?? COMPOSED, transcript: '' }),
    }),
    publishers: [publisher],
  });
  return { db, dir, pipeline };
}

const brief = { targetPlatforms: ['dryrun'], locale: 'en-US' as const };

test('full loop: ingest → compose → propose → approve → publish', async () => {
  const { db, dir, pipeline } = build();

  const ingest = await pipeline.ingest();
  assert.equal(ingest.stored, 2);

  const { variants } = await pipeline.compose({ ...brief, sources: ingest.items });
  assert.equal(variants.length, 1);

  const { approvals } = await pipeline.propose(variants);
  assert.equal(approvals.length, 1);
  assert.deepEqual(await pipeline.executeDue(), { published: [], failed: [] }, 'pending must not publish');

  pipeline.queue.approve(approvals[0]!.id);
  const exec = await pipeline.executeDue();

  assert.equal(exec.published.length, 1);
  assert.equal(exec.failed.length, 0);
  const post = db.prepare(`SELECT * FROM posts`).get() as any;
  assert.equal(post.state, 'published');
  assert.ok(post.platform_post_id);

  const files = fs.readdirSync(path.join(dir, 'dryrun'));
  assert.ok(files.some((f) => f.endsWith('.md')) && files.some((f) => f.endsWith('.json')));
});

test('re-ingesting the same feed stores nothing new', async () => {
  const { pipeline } = build();
  assert.equal((await pipeline.ingest()).stored, 2);
  const second = await pipeline.ingest();
  assert.equal(second.fetched, 2);
  assert.equal(second.stored, 0, 'repeat polling must not duplicate rows');
});

test('a failing source does not lose results from the others', async () => {
  const broken: SourceProvider = {
    info: { id: 'broken', slot: 'source', name: 'broken' },
    kind: 'news',
    healthCheck: async () => ({ ok: false }),
    fetch: async () => {
      throw new ProviderError('upstream down', 'transient', true);
    },
  };
  const { pipeline } = build({
    sources: [
      broken,
      new RssSourceProvider({
        feeds: ['https://e.com/feed'],
        fetchImpl: (async () => new Response(FEED, { status: 200 })) as unknown as typeof fetch,
      }),
    ],
  });

  const res = await pipeline.ingest();
  assert.equal(res.stored, 2, 'the healthy source still lands');
  assert.deepEqual(res.errors.map((e) => e.providerId), ['broken']);
});

test('executing twice publishes only once', async () => {
  const { db, pipeline } = build();
  const ingest = await pipeline.ingest();
  const { variants } = await pipeline.compose({ ...brief, sources: ingest.items });
  const { approvals } = await pipeline.propose(variants);
  pipeline.queue.approve(approvals[0]!.id);

  const first = await pipeline.executeDue();
  const second = await pipeline.executeDue();

  assert.equal(first.published.length, 1);
  assert.equal(second.published.length, 0, 'replay must be an idempotent no-op');
  assert.equal((db.prepare(`SELECT COUNT(*) c FROM posts`).get() as any).c, 1);
});

test('tampering after approval blocks the publish', async () => {
  const { db, pipeline } = build();
  const ingest = await pipeline.ingest();
  const { variants } = await pipeline.compose({ ...brief, sources: ingest.items });
  const { approvals } = await pipeline.propose(variants);
  pipeline.queue.approve(approvals[0]!.id);

  db.prepare(`UPDATE approvals SET payload = ? WHERE id = ?`).run(
    JSON.stringify({ ...variants[0], body: 'INJECTED' }),
    approvals[0]!.id,
  );

  const exec = await pipeline.executeDue();
  assert.equal(exec.published.length, 0);
  assert.match(exec.failed[0]!.error, /payload changed/);
  assert.equal(pipeline.queue.get(approvals[0]!.id)!.state, 'pending');
});

test('variants failing validation are skipped, not queued', async () => {
  const db = open(':memory:');
  const publisher = new DryRunPublisher({ outDir: outDir(), limits: { maxTextLength: 5 } });
  const pipeline = new Pipeline(db, {
    composer: new ClaudeComposer({ runner: async () => ({ text: COMPOSED, transcript: '' }) }),
    publishers: [publisher],
  });

  const { variants } = await pipeline.compose({ ...brief, sources: [] });
  const res = await pipeline.propose(variants);

  assert.equal(res.approvals.length, 0);
  assert.match(res.skipped[0]!.reason, /text_too_long/);
  const stored = db.prepare(`SELECT validation FROM draft_variants`).get() as any;
  assert.match(stored.validation, /text_too_long/, 'the failure is recorded on the variant');
});

test('a platform with no publisher is skipped with a reason', async () => {
  const { pipeline } = build();
  const { variants } = await pipeline.compose({ ...brief, sources: [] });
  const res = await pipeline.propose([{ ...variants[0]!, platform: 'tiktok' }]);
  assert.deepEqual(res.skipped, [{ platform: 'tiktok', reason: 'no publisher configured' }]);
});

test('composer failure records a discarded draft and rethrows', async () => {
  const { db, pipeline } = build({ composerText: 'sorry, no json here' });
  await assert.rejects(pipeline.compose({ ...brief, sources: [] }), ProviderError);

  const draft = db.prepare(`SELECT state, error FROM drafts`).get() as any;
  assert.equal(draft.state, 'discarded');
  assert.match(draft.error, /parseable/, 'the failure reason is recorded on the draft');
});

test('scheduled approvals wait for their time', async () => {
  const db = open(':memory:');
  let clock = 1_000_000;
  const pipeline = new Pipeline(
    db,
    {
      composer: new ClaudeComposer({ runner: async () => ({ text: COMPOSED, transcript: '' }) }),
      publishers: [new DryRunPublisher({ outDir: outDir() })],
    },
    () => clock,
  );

  const { variants } = await pipeline.compose({ ...brief, sources: [] });
  const { approvals } = await pipeline.propose(variants, { scheduledFor: new Date(clock + 60_000) });
  pipeline.queue.approve(approvals[0]!.id);

  assert.equal((await pipeline.executeDue()).published.length, 0, 'not due yet');
  clock += 61_000;
  assert.equal((await pipeline.executeDue()).published.length, 1);
});

test('runOnce with autoApprove drives the whole loop', async () => {
  const { pipeline } = build();
  const res = await pipeline.runOnce(brief, { autoApprove: true, dryRun: true });

  assert.equal(res.ingest.stored, 2);
  assert.equal(res.propose.approvals.length, 1);
  assert.equal(res.execute!.published.length, 1);
});

test('runOnce without autoApprove stops at the gate', async () => {
  const { pipeline } = build();
  const res = await pipeline.runOnce(brief);
  assert.equal(res.execute, undefined);
  assert.equal(pipeline.queue.list('pending').length, 1);
});

test('every stage is recorded in runs', async () => {
  const { db, pipeline } = build();
  await pipeline.runOnce(brief, { autoApprove: true, dryRun: true });
  const kinds = (db.prepare(`SELECT DISTINCT kind FROM runs`).all() as any[]).map((r) => r.kind);
  for (const k of ['source_poll', 'compose', 'publish']) assert.ok(kinds.includes(k), `missing run kind ${k}`);
  assert.equal((db.prepare(`SELECT COUNT(*) c FROM runs WHERE state='running'`).get() as any).c, 0);
});

test('clearing the schedule on approval publishes a parked item immediately (--now)', async () => {
  let clock = Date.UTC(2026, 6, 1);
  const db = open(':memory:');
  const pipeline = new Pipeline(
    db,
    {
      composer: new ClaudeComposer({ runner: async () => ({ text: COMPOSED, transcript: '' }) }),
      publishers: [new DryRunPublisher({ outDir: outDir() })],
    },
    () => clock,
  );

  const { variants } = await pipeline.compose({ ...brief, sources: [] });
  const { approvals } = await pipeline.propose(variants, { scheduledFor: new Date(clock + 86_400_000) });

  // Approved as scheduled: not due yet.
  pipeline.queue.approve(approvals[0]!.id);
  assert.equal((await pipeline.executeDue()).published.length, 0);

  // Re-approving with scheduledFor: null is what `approve --now` does; the item
  // must go out on this tick even though its original slot is a day away.
  // (approve() only runs on pending items, so reset for the test.)
  db.prepare(`UPDATE approvals SET state='pending' WHERE id=?`).run(approvals[0]!.id);
  pipeline.queue.approve(approvals[0]!.id, { scheduledFor: null });
  assert.equal((await pipeline.executeDue()).published.length, 1);
});

test('a standing rule carries a proposal straight to approved', async () => {
  const { db, pipeline, dir } = build();
  const target = path.resolve(dir, 'dryrun');
  pipeline.queue.standingRules.grant({
    action: 'publish:dryrun',
    target,
    consequence: 'local',
  });

  const { variants } = await pipeline.compose({ ...brief, sources: [] });
  const { approvals } = await pipeline.propose(variants);

  assert.equal(approvals[0]!.state, 'approved');
  assert.equal(approvals[0]!.decidedBy, `rule:publish:dryrun ${target}`);
  assert.equal((await pipeline.executeDue()).published.length, 1);
  assert.equal((db.prepare(`SELECT COUNT(*) c FROM approvals WHERE state='pending'`).get() as any).c, 0);
});

test('proposals stay pending when the rule names a different target', async () => {
  const { pipeline } = build();
  pipeline.queue.standingRules.grant({
    action: 'publish:dryrun',
    target: '/somewhere/else',
    consequence: 'local',
  });

  const { variants } = await pipeline.compose({ ...brief, sources: [] });
  const { approvals } = await pipeline.propose(variants);
  assert.equal(approvals[0]!.state, 'pending');
});

test('run arguments are recorded, but sanitized', async () => {
  const { db, pipeline } = build();
  await pipeline.runOnce(brief, { autoApprove: true, dryRun: true });

  const publish = db.prepare(`SELECT args FROM runs WHERE kind='publish'`).get() as any;
  const args = JSON.parse(publish.args);
  assert.equal(args.platform, 'dryrun');
  assert.ok(args.variantId, 'the run must name what it published');
  // The body lives in draft_variants; the audit row only needs to identify it.
  assert.match(args.body, /\[13 chars\]$/);
});

test('a provider error mentioning a token is redacted before it reaches runs', async () => {
  const db = open(':memory:');
  const publisher = new DryRunPublisher({ outDir: outDir() });
  publisher.publish = async () => {
    throw new ProviderError('xhs --token=super-secret-abc rejected the post', 'rejected', false);
  };
  const pipeline = new Pipeline(db, {
    composer: new ClaudeComposer({ runner: async () => ({ text: COMPOSED, transcript: '' }) }),
    publishers: [publisher],
  });

  const { variants } = await pipeline.compose({ ...brief, sources: [] });
  const { approvals } = await pipeline.propose(variants);
  pipeline.queue.approve(approvals[0]!.id);
  await pipeline.executeDue();

  const detail = (db.prepare(`SELECT detail FROM runs WHERE kind='publish'`).get() as any).detail;
  assert.ok(!detail.includes('super-secret-abc'), `token leaked into runs.detail: ${detail}`);
  assert.match(detail, /--token=\[redacted\]/);
});
