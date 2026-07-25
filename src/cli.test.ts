import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execFile);
const CLI = path.join(__dirname, 'cli.ts');
const TSX = path.join(__dirname, '..', 'node_modules', '.bin', 'tsx');

const FEED = `<rss><channel>
<item><title>CLI end to end</title><guid>g-1</guid><link>https://example.com/1</link>
<pubDate>Tue, 01 Jul 2026 10:00:00 GMT</pubDate></item>
</channel></rss>`;

const COMPOSED_JSON = JSON.stringify({
  variants: [{ platform: 'dryrun', title: 'Shipped', body: 'The loop runs end to end.' }],
});

/** A fake `claude` that emits one valid JSONL transcript. */
function fakeClaude(dir: string): string {
  const bin = path.join(dir, 'fake-claude');
  const result = JSON.stringify({
    type: 'result',
    result: '```json\n' + COMPOSED_JSON + '\n```',
  });
  fs.writeFileSync(bin, `#!/bin/sh\ncat <<'JSONL'\n${result}\nJSONL\n`, { mode: 0o755 });
  return bin;
}

async function withFeedServer<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end(FEED);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  try {
    return await fn(`http://127.0.0.1:${port}/feed.xml`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

function setup(feedUrl: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mediabot-cli-'));
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ feeds: [feedUrl], targetPlatforms: ['dryrun'], locale: 'en-US' }),
  );
  return {
    home,
    env: { ...process.env, MEDIABOT_HOME: home, CLAUDE_BIN: fakeClaude(home) },
  };
}

function run(args: string[], env: NodeJS.ProcessEnv) {
  return exec(TSX, [CLI, ...args], { env, timeout: 60_000 });
}

test('run → queue → approve publishes, and ingest is idempotent', async () => {
  await withFeedServer(async (feedUrl) => {
    const { home, env } = setup(feedUrl);

    const first = await run(['run'], env);
    assert.match(first.stdout, /ingested 1 new of 1 fetched/);
    assert.match(first.stdout, /queued 1 for approval/);

    const queued = await run(['queue'], env);
    assert.match(queued.stdout, /publish\s+dryrun/);
    assert.match(queued.stdout, /Shipped — The loop runs end to end\./);

    const id = queued.stdout.trim().split(/\s+/)[0]!;
    assert.match(id, /^appr_/);

    const approved = await run(['approve', id], env);
    assert.match(approved.stdout, /published post_/);

    const files = fs.readdirSync(path.join(home, 'out', 'dryrun'));
    assert.ok(files.some((f) => f.endsWith('.md')), 'markdown artifact written');
    const md = fs.readFileSync(path.join(home, 'out', 'dryrun', files.find((f) => f.endsWith('.md'))!), 'utf8');
    assert.match(md, /# Shipped/);
    assert.match(md, /The loop runs end to end\./);

    // A second run re-fetches the same feed but must store nothing new.
    const second = await run(['run'], env);
    assert.match(second.stdout, /ingested 0 new of 1 fetched/);
  });
});

test('pending approvals are never published by run alone', async () => {
  await withFeedServer(async (feedUrl) => {
    const { home, env } = setup(feedUrl);
    await run(['run'], env);
    assert.ok(!fs.existsSync(path.join(home, 'out')), 'nothing may ship before approval');
  });
});

test('reject prevents publication', async () => {
  await withFeedServer(async (feedUrl) => {
    const { home, env } = setup(feedUrl);
    await run(['run'], env);
    const id = (await run(['queue'], env)).stdout.trim().split(/\s+/)[0]!;

    await run(['reject', id, 'off', 'brand'], env);
    assert.match((await run(['queue'], env)).stdout, /no pending approvals/);
    assert.match((await run(['queue', 'rejected'], env)).stdout, new RegExp(id));
    assert.ok(!fs.existsSync(path.join(home, 'out')));
  });
});

test('--auto runs the whole loop unattended', async () => {
  await withFeedServer(async (feedUrl) => {
    const { home, env } = setup(feedUrl);
    const res = await run(['run', '--auto', '--dry'], env);
    assert.match(res.stdout, /published 1/);
    assert.ok(fs.existsSync(path.join(home, 'out', 'dryrun')));
  });
});

test('providers reports health for each slot', async () => {
  await withFeedServer(async (feedUrl) => {
    const { env } = setup(feedUrl);
    const res = await run(['providers'], env);
    assert.match(res.stdout, /source\s+rss\s+ok/);
    assert.match(res.stdout, /composer\s+claude\s+ok/);
    assert.match(res.stdout, /publisher\s+dryrun\s+api\s+ok/);
  });
});

test('status counts rows and lists recent runs', async () => {
  await withFeedServer(async (feedUrl) => {
    const { env } = setup(feedUrl);
    await run(['run'], env);
    const res = await run(['status'], env);
    assert.match(res.stdout, /source_items\s+1/);
    assert.match(res.stdout, /draft_variants\s+1/);
    assert.match(res.stdout, /1 awaiting approval/);
    assert.match(res.stdout, /recent runs:/);
  });
});

test('help is shown with no arguments and unknown commands exit non-zero', async () => {
  const { env } = setup('http://127.0.0.1:1/none');
  assert.match((await run([], env)).stdout, /Usage:/);
  await assert.rejects(run(['bogus'], env), /unknown command/);
});

test('init writes a runnable starter config and refuses to clobber it', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mediabot-init-'));
  const env = { ...process.env, MEDIABOT_HOME: home };

  const first = await run(['init'], env);
  assert.match(first.stdout, /wrote .*config\.json/);

  const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.deepEqual(cfg.targetPlatforms, ['dryrun'], 'a fresh user posts nowhere real yet');
  assert.ok(Array.isArray(cfg.feeds) && cfg.feeds.length, 'ships a feed so the first run has material');

  // A second init must not overwrite a config someone may have edited.
  await assert.rejects(run(['init'], env), /already exists/);
  const forced = await run(['init', '--force'], env);
  assert.match(forced.stdout, /wrote/);
});

test('approve --now is accepted, labelled, and publishes', async () => {
  await withFeedServer(async (feedUrl) => {
    const { env } = setup(feedUrl);
    await run(['run'], env);
    const id = (await run(['queue'], env)).stdout.trim().split(/\s+/)[0]!;

    const approved = await run(['approve', id, '--now'], env);
    assert.match(approved.stdout, /approved .* \(now\)/);
    assert.match(approved.stdout, /published post_/);
  });
});
