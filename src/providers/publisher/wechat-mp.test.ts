import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { WeChatMpPublisher } from './wechat-mp';
import { runConformance } from '../../testing/conformance';
import { ProviderError, type DraftVariant } from '../../contracts';

/** Records every request so tests can assert on the calls, never the network. */
function stubFetch(routes: Record<string, unknown>, calls: string[] = []): typeof fetch {
  return (async (input: any, init?: any) => {
    const url = String(input);
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new Error(`unexpected request: ${url}`);
    const body = routes[key];
    return new Response(JSON.stringify(typeof body === 'function' ? (body as any)(init) : body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

function image(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediabot-mp-'));
  const p = path.join(dir, 'cover.png');
  fs.writeFileSync(p, 'png-bytes');
  return p;
}

function variant(over: Partial<DraftVariant> = {}): DraftVariant {
  return {
    id: 'dv_1',
    platform: 'wechat-mp',
    title: '文章标题',
    body: '<p>正文</p>',
    media: [{ kind: 'image', path: image() }],
    ...over,
  };
}

const OK_TOKEN = { access_token: 'tok-123', expires_in: 7200 };
const OK_MATERIAL = { media_id: 'cover-media-1' };
const OK_DRAFT = { media_id: 'draft-media-1' };

function publisher(routes: Record<string, unknown>, calls: string[] = []) {
  return new WeChatMpPublisher({
    appId: 'wxtest',
    appSecret: 'secret',
    fetchImpl: stubFetch(routes, calls),
  });
}

test('checkAuth fails clearly when credentials are absent', async () => {
  const p = new WeChatMpPublisher({ appId: '', appSecret: '', fetchImpl: stubFetch({}) });
  const state = await p.checkAuth();
  assert.equal(state.ok, false);
  assert.match(state.reason!, /WECHAT_APP_ID/);
});

test('checkAuth acquires a token and reports its expiry', async () => {
  const p = publisher({ '/cgi-bin/token': OK_TOKEN });
  const state = await p.checkAuth();
  assert.equal(state.ok, true);
  assert.ok(state.expiresAt instanceof Date);
});

test('the access token is cached rather than re-fetched per call', async () => {
  const calls: string[] = [];
  const p = publisher({ '/cgi-bin/token': OK_TOKEN }, calls);
  await p.checkAuth();
  await p.checkAuth();
  assert.equal(calls.filter((u) => u.includes('/cgi-bin/token')).length, 1);
});

test('an expired cached token is refreshed', async () => {
  const calls: string[] = [];
  let clock = 1_000_000;
  const p = new WeChatMpPublisher({
    appId: 'wxtest',
    appSecret: 'secret',
    fetchImpl: stubFetch({ '/cgi-bin/token': OK_TOKEN }, calls),
    tokenTtlMs: 1000,
    now: () => clock,
  });
  await p.checkAuth();
  clock += 5000;
  await p.checkAuth();
  assert.equal(calls.filter((u) => u.includes('/cgi-bin/token')).length, 2);
});

test('validation enforces title and body rules', async () => {
  const p = publisher({});
  const codes = async (v: DraftVariant) => (await p.validate(v)).errors.map((e) => e.code);

  assert.equal((await p.validate(variant())).ok, true);
  assert.deepEqual(await codes(variant({ title: '' })), ['title_required']);
  assert.deepEqual(await codes(variant({ title: 'x'.repeat(65) })), ['title_too_long']);
  assert.deepEqual(await codes(variant({ body: '  ' })), ['empty_body']);
});

test('warns when there is no cover image', async () => {
  const res = await publisher({}).validate(variant({ media: [] }));
  assert.equal(res.ok, true);
  assert.deepEqual(res.warnings.map((w) => w.code), ['no_cover']);
});

test('publish uploads the cover then creates a draft — and never mass-sends', async () => {
  const calls: string[] = [];
  const p = publisher(
    {
      '/cgi-bin/token': OK_TOKEN,
      '/cgi-bin/material/add_material': OK_MATERIAL,
      '/cgi-bin/draft/add': OK_DRAFT,
    },
    calls,
  );

  const res = await p.publish(variant(), { accountId: 'acc' });

  assert.equal(res.platformPostId, 'draft-media-1');
  assert.ok(calls.some((u) => u.includes('/cgi-bin/material/add_material')));
  assert.ok(calls.some((u) => u.includes('/cgi-bin/draft/add')));
  assert.ok(
    !calls.some((u) => u.includes('freepublish')),
    'mass-sending burns a limited daily quota and cannot be undone — a human presses send',
  );
});

test('an article with no image skips the upload step', async () => {
  const calls: string[] = [];
  const p = publisher({ '/cgi-bin/token': OK_TOKEN, '/cgi-bin/draft/add': OK_DRAFT }, calls);
  await p.publish(variant({ media: [] }), { accountId: 'acc' });
  assert.ok(!calls.some((u) => u.includes('add_material')));
});

test('dry run performs no requests at all', async () => {
  const calls: string[] = [];
  const p = publisher({ '/cgi-bin/token': OK_TOKEN }, calls);
  const res = await p.publish(variant(), { accountId: 'acc', dryRun: true });
  assert.equal(calls.length, 0);
  assert.match(res.platformPostId, /^dryrun_/);
});

test('a stale token error is retryable, a non-whitelisted IP is not', async () => {
  const stale = publisher({ '/cgi-bin/token': { errcode: 40001, errmsg: 'invalid credential' } });
  await assert.rejects(stale.publish(variant(), { accountId: 'a' }), (err: unknown) => {
    assert.ok(err instanceof ProviderError);
    assert.equal(err.code, 'auth_expired');
    assert.equal(err.retryable, true);
    return true;
  });

  const blocked = publisher({
    '/cgi-bin/token': OK_TOKEN,
    '/cgi-bin/material/add_material': OK_MATERIAL,
    '/cgi-bin/draft/add': { errcode: 61004, errmsg: 'ip not in whitelist' },
  });
  await assert.rejects(blocked.publish(variant(), { accountId: 'a' }), (err: unknown) => {
    assert.ok(err instanceof ProviderError);
    assert.equal(err.retryable, false, 'retrying a whitelist problem just loops');
    assert.match(err.message, /allowlist/);
    return true;
  });
});

test('rate limit errors are retryable', async () => {
  const p = publisher({
    '/cgi-bin/token': OK_TOKEN,
    '/cgi-bin/material/add_material': OK_MATERIAL,
    '/cgi-bin/draft/add': { errcode: 45009, errmsg: 'api freq out of limit' },
  });
  await assert.rejects(p.publish(variant(), { accountId: 'a' }), (err: unknown) => {
    assert.equal((err as ProviderError).code, 'rate_limited');
    assert.equal((err as ProviderError).retryable, true);
    return true;
  });
});

test('meta fields flow into the draft payload', async () => {
  let sent: any;
  const fetchImpl = (async (url: any, init?: any) => {
    const u = String(url);
    if (u.includes('/cgi-bin/token')) return new Response(JSON.stringify(OK_TOKEN));
    if (u.includes('add_material')) return new Response(JSON.stringify(OK_MATERIAL));
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify(OK_DRAFT));
  }) as unknown as typeof fetch;

  const p = new WeChatMpPublisher({ appId: 'a', appSecret: 'b', fetchImpl });
  await p.publish(
    variant({ meta: { author: '张三', digest: '摘要', sourceUrl: 'https://blog', openComment: true } }),
    { accountId: 'acc' },
  );

  const article = sent.articles[0];
  assert.equal(article.author, '张三');
  assert.equal(article.digest, '摘要');
  assert.equal(article.content_source_url, 'https://blog');
  assert.equal(article.need_open_comment, 1);
  assert.equal(article.thumb_media_id, 'cover-media-1');
});

test('passes the publisher conformance suite', async () => {
  const p = publisher({
    '/cgi-bin/token': OK_TOKEN,
    '/cgi-bin/material/add_material': OK_MATERIAL,
    '/cgi-bin/draft/add': OK_DRAFT,
  });
  const report = await runConformance(p, 'publisher');
  assert.ok(report.passed, report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('\n'));
});
