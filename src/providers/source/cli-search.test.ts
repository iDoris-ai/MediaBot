import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CliSearchSource } from './cli-search';
import { runConformance } from '../../testing/conformance';
import { ProviderError } from '../../contracts';
import type { CliRunner } from '../../core/cli-adapter';

function runner(byCommand: Record<string, unknown>, calls: string[][] = []): CliRunner {
  return async (_bin, args) => {
    calls.push(args);
    const key = args[0]!;
    if (!(key in byCommand)) throw new ProviderError(`no stub for ${key}`, 'unknown', false);
    const v = byCommand[key];
    if (v instanceof Error) throw v;
    return { stdout: JSON.stringify(v), stderr: '' };
  };
}

const XHS_PAGE = {
  ok: true,
  data: {
    items: [
      {
        id: 'note-1',
        note_card: {
          display_title: '第一条笔记',
          interact_info: { liked_count: '1064' },
          user: { nickname: 'winston' },
        },
      },
      {
        id: 'note-2',
        note_card: { display_title: '第二条', interact_info: { liked_count: '20' } },
      },
      { id: 'broken', note_card: {} },
    ],
  },
};

const OK_STATUS = { ok: true, data: { authenticated: true } };

test('maps XHS search results into namespaced items ranked by likes', async () => {
  const s = new CliSearchSource('xiaohongshu', { runner: runner({ search: XHS_PAGE }) });
  const items = await s.fetch({ keywords: ['AI'] });

  assert.deepEqual(items.map((i) => i.id), ['xhs-search:note-1', 'xhs-search:note-2']);
  assert.equal(items[0]!.title, '第一条笔记');
  assert.equal(items[0]!.score, 1064);
  assert.equal(items[0]!.summary, '@winston');
  assert.equal(items[0]!.url, 'https://www.xiaohongshu.com/explore/note-1');
  assert.equal(items[0]!.providerId, 'xhs-search');
});

test('a row missing its title is skipped rather than emitted empty', async () => {
  const s = new CliSearchSource('xiaohongshu', { runner: runner({ search: XHS_PAGE }) });
  const items = await s.fetch({ keywords: ['AI'] });
  assert.ok(!items.some((i) => i.id.endsWith('broken')));
});

test('the same item found by two keywords appears once', async () => {
  const s = new CliSearchSource('xiaohongshu', { runner: runner({ search: XHS_PAGE }) });
  const items = await s.fetch({ keywords: ['AI', 'Agent'] });
  assert.equal(new Set(items.map((i) => i.id)).size, items.length);
  assert.equal(items.length, 2);
});

test('ids are stable across polls, so re-polling cannot duplicate rows', async () => {
  const s = new CliSearchSource('xiaohongshu', { runner: runner({ search: XHS_PAGE }) });
  const a = (await s.fetch({ keywords: ['AI'] })).map((i) => i.id);
  const b = (await s.fetch({ keywords: ['AI'] })).map((i) => i.id);
  assert.deepEqual(a, b);
});

test('a failing keyword does not lose the results of the others', async () => {
  let call = 0;
  const flaky: CliRunner = async (_bin, args) => {
    if (args[0] === 'status') return { stdout: JSON.stringify(OK_STATUS), stderr: '' };
    call += 1;
    if (call === 1) throw new ProviderError('search blew up', 'transient', true);
    return { stdout: JSON.stringify(XHS_PAGE), stderr: '' };
  };
  const s = new CliSearchSource('xiaohongshu', { runner: flaky });
  const items = await s.fetch({ keywords: ['bad', 'good'] });
  assert.equal(items.length, 2, 'the second keyword still yields results');
});

test('an expired login aborts instead of silently returning nothing', async () => {
  const dead: CliRunner = async () => {
    throw new ProviderError('please log in', 'auth_expired', false);
  };
  const s = new CliSearchSource('xiaohongshu', { runner: dead });
  await assert.rejects(s.fetch({ keywords: ['AI'] }), (err: unknown) => {
    assert.equal((err as ProviderError).code, 'auth_expired');
    return true;
  });
});

test('no keywords means no work and no CLI call', async () => {
  const calls: string[][] = [];
  const s = new CliSearchSource('xiaohongshu', { runner: runner({ search: XHS_PAGE }, calls) });
  assert.deepEqual(await s.fetch({}), []);
  assert.equal(calls.length, 0);
});

test('configured default keywords are used when the query omits them', async () => {
  const calls: string[][] = [];
  const s = new CliSearchSource('xiaohongshu', {
    runner: runner({ search: XHS_PAGE }, calls),
    keywords: ['默认词'],
  });
  await s.fetch({});
  assert.equal(calls[0]![1], '默认词');
});

test('limit caps the result set', async () => {
  const s = new CliSearchSource('xiaohongshu', { runner: runner({ search: XHS_PAGE }) });
  assert.equal((await s.fetch({ keywords: ['AI'], limit: 1 })).length, 1);
});

test('twitter results map text, handle and timestamp', async () => {
  const page = {
    data: {
      tweets: [
        {
          id_str: '99',
          full_text: 'First line here\nsecond line',
          created_at: '2026-07-01T00:00:00Z',
          favorite_count: 12,
          user: { screenName: 'someone' },
        },
      ],
    },
  };
  const s = new CliSearchSource('twitter', { runner: runner({ search: page }) });
  const [item] = await s.fetch({ keywords: ['ai'] });

  assert.equal(item!.id, 'twitter-search:99');
  assert.equal(item!.title, 'First line here', 'a tweet has no title; the first line stands in');
  assert.equal(item!.summary, 'First line here\nsecond line');
  assert.equal(item!.url, 'https://x.com/someone/status/99');
  assert.equal(item!.publishedAt!.toISOString(), '2026-07-01T00:00:00.000Z');
});

test('since filters out older items', async () => {
  const page = {
    data: {
      tweets: [
        { id_str: '1', full_text: 'old', created_at: '2026-01-01T00:00:00Z' },
        { id_str: '2', full_text: 'new', created_at: '2026-07-01T00:00:00Z' },
      ],
    },
  };
  const s = new CliSearchSource('twitter', { runner: runner({ search: page }) });
  const items = await s.fetch({ keywords: ['x'], since: new Date('2026-06-01T00:00:00Z') });
  assert.deepEqual(items.map((i) => i.id), ['twitter-search:2']);
});

test('bilibili results strip search highlight tags and convert pubdate', async () => {
  const page = {
    data: {
      results: [
        { bvid: 'BV1x', title: 'AI <em class="keyword">Agent</em> 教程', author: 'up主', play: 5000, pubdate: 1_780_000_000 },
      ],
    },
  };
  const s = new CliSearchSource('bilibili', { runner: runner({ search: page }) });
  const [item] = await s.fetch({ keywords: ['agent'] });

  assert.equal(item!.title, 'AI Agent 教程');
  assert.equal(item!.url, 'https://www.bilibili.com/video/BV1x');
  assert.equal(item!.score, 5000);
  assert.equal(item!.publishedAt!.getTime(), 1_780_000_000_000);
});

test('healthCheck reports login state', async () => {
  const ok = new CliSearchSource('xiaohongshu', { runner: runner({ status: OK_STATUS }) });
  assert.deepEqual(await ok.healthCheck(), { ok: true });

  const anon = new CliSearchSource('xiaohongshu', {
    runner: runner({ status: { ok: true, data: { authenticated: false } } }),
  });
  assert.equal((await anon.healthCheck()).ok, false);
});

test('passes the source conformance suite, including eyes-not-hands', async () => {
  const s = new CliSearchSource('xiaohongshu', {
    runner: runner({ status: OK_STATUS, search: XHS_PAGE }),
    keywords: ['AI'],
  });
  const report = await runConformance(s, 'source');
  assert.ok(report.passed, report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('\n'));
});
