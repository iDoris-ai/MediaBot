import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RssSourceProvider, parseFeed } from './rss';
import { ProviderError } from '../../contracts';

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item>
    <title>Older post</title>
    <guid>g-1</guid>
    <link>https://example.com/1</link>
    <description><![CDATA[Summary <b>one</b> &amp; more]]></description>
    <pubDate>Tue, 01 Jul 2026 10:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Newer post</title>
    <guid>g-2</guid>
    <link>https://example.com/2</link>
    <pubDate>Wed, 02 Jul 2026 10:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Atom entry</title>
    <id>atom-1</id>
    <link href="https://example.com/atom/1"/>
    <summary>An atom summary</summary>
    <updated>2026-07-03T10:00:00Z</updated>
  </entry>
</feed>`;

function stub(body: string, status = 200): typeof fetch {
  return (async () => new Response(body, { status })) as unknown as typeof fetch;
}

function provider(body = RSS) {
  return new RssSourceProvider({ feeds: ['https://example.com/feed'], fetchImpl: stub(body) });
}

test('parses RSS items into namespaced SourceItems', async () => {
  const items = await provider().fetch();
  assert.equal(items.length, 2);
  const older = items.find((i) => i.title === 'Older post')!;
  assert.equal(older.id, 'rss:g-1');
  assert.equal(older.providerId, 'rss');
  assert.equal(older.url, 'https://example.com/1');
  assert.equal(older.summary, 'Summary one & more', 'CDATA, tags and entities must be stripped');
  assert.equal(older.publishedAt?.toISOString(), '2026-07-01T10:00:00.000Z');
});

test('parses Atom entries including href links', async () => {
  const items = await provider(ATOM).fetch();
  assert.equal(items.length, 1);
  assert.equal(items[0]!.id, 'rss:atom-1');
  assert.equal(items[0]!.url, 'https://example.com/atom/1');
  assert.equal(items[0]!.summary, 'An atom summary');
});

test('ids are identical across repeated fetches', async () => {
  const p = provider();
  const a = (await p.fetch()).map((i) => i.id).sort();
  const b = (await p.fetch()).map((i) => i.id).sort();
  assert.deepEqual(a, b, 'unstable ids would duplicate rows on every poll');
});

test('falls back to a content hash when the feed has no guid', async () => {
  const noGuid = `<rss><channel><item>
    <title>No guid here</title><link>https://example.com/x</link>
  </item></channel></rss>`;
  const p = new RssSourceProvider({ feeds: ['f'], fetchImpl: stub(noGuid) });
  const first = (await p.fetch())[0]!;
  const second = (await p.fetch())[0]!;
  assert.equal(first.id, second.id);
  assert.match(first.id, /^rss:[0-9a-f]{16}$/);
});

test('returns newest first so limit keeps the most recent', async () => {
  const items = await provider().fetch({ limit: 1 });
  assert.equal(items.length, 1);
  assert.equal(items[0]!.title, 'Newer post');
});

test('filters by since', async () => {
  const items = await provider().fetch({ since: new Date('2026-07-02T00:00:00Z') });
  assert.deepEqual(items.map((i) => i.title), ['Newer post']);
});

test('filters by keyword across title and summary', async () => {
  assert.deepEqual(
    (await provider().fetch({ keywords: ['newer'] })).map((i) => i.title),
    ['Newer post'],
  );
  assert.deepEqual(
    (await provider().fetch({ keywords: ['summary'] })).map((i) => i.title),
    ['Older post'],
    'keyword should match the summary too',
  );
});

test('marks 5xx and 429 as retryable, 404 as not', async () => {
  const cases: [number, boolean][] = [
    [503, true],
    [429, true],
    [404, false],
  ];
  for (const [status, retryable] of cases) {
    const p = new RssSourceProvider({ feeds: ['f'], fetchImpl: stub('', status) });
    await assert.rejects(p.fetch(), (err: unknown) => {
      assert.ok(err instanceof ProviderError, `status ${status} should raise ProviderError`);
      assert.equal(err.retryable, retryable, `status ${status} retryable should be ${retryable}`);
      return true;
    });
  }
});

test('healthCheck fails when no feeds are configured', async () => {
  const p = new RssSourceProvider({ feeds: [], fetchImpl: stub(RSS) });
  assert.deepEqual(await p.healthCheck(), { ok: false, detail: 'no feeds configured' });
});

test('parseFeed skips entries without a title', () => {
  const entries = parseFeed(`<rss><channel>
    <item><link>https://example.com/no-title</link></item>
    <item><title>Has one</title></item>
  </channel></rss>`);
  assert.deepEqual(entries.map((e) => e.title), ['Has one']);
});
