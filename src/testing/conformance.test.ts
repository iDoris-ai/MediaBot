import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runConformance } from './conformance';
import { RssSourceProvider } from '../providers/source/rss';
import { DryRunPublisher } from '../providers/publisher/dryrun';
import type { PublisherProvider, SourceProvider } from '../contracts';

const FEED = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item>
    <title>First post</title>
    <guid>abc-1</guid>
    <link>https://example.com/1</link>
    <description><![CDATA[Summary <b>one</b>]]></description>
    <pubDate>Tue, 01 Jul 2026 10:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Second post</title>
    <guid>abc-2</guid>
    <link>https://example.com/2</link>
    <pubDate>Wed, 02 Jul 2026 10:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

function stubFetch(body = FEED): typeof fetch {
  return (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
}

function outDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mediabot-out-'));
}

test('RSS provider passes the source conformance suite', async () => {
  const p = new RssSourceProvider({ feeds: ['https://example.com/feed'], fetchImpl: stubFetch() });
  const report = await runConformance(p, 'source');
  assert.ok(report.passed, failure(report));
});

test('dry-run publisher passes the publisher conformance suite', async () => {
  const p = new DryRunPublisher({ outDir: outDir() });
  const report = await runConformance(p, 'publisher');
  assert.ok(report.passed, failure(report));
});

test('suite rejects a source whose item ids are not namespaced', async () => {
  const bad = new RssSourceProvider({ feeds: ['https://x/f'], fetchImpl: stubFetch() });
  const broken: SourceProvider = {
    ...bad,
    info: bad.info,
    kind: bad.kind,
    healthCheck: () => bad.healthCheck(),
    fetch: async () => [
      { id: 'no-namespace', providerId: bad.info.id, kind: 'news' as const, title: 'x' },
    ],
  };
  const report = await runConformance(broken, 'source');
  assert.equal(report.passed, false);
  assert.ok(report.checks.some((c) => !c.ok && /namespaced/.test(c.name)));
});

test('suite rejects a source that exposes a write method', async () => {
  const bad = new RssSourceProvider({ feeds: ['https://x/f'], fetchImpl: stubFetch() });
  const broken = Object.assign(Object.create(Object.getPrototypeOf(bad)), bad, {
    publish: async () => undefined,
  });
  const report = await runConformance(broken, 'source');
  assert.equal(report.passed, false);
  assert.ok(
    report.checks.some((c) => !c.ok && /read-only/.test(c.name)),
    'a source with publish() must fail the eyes-not-hands check',
  );
});

test('suite rejects a publisher whose limits do not match its behaviour', async () => {
  const real = new DryRunPublisher({ outDir: outDir() });
  // Claims a 10-char limit but validates against the real 2000 — exactly the
  // drift the conformance kit exists to catch.
  const lying: PublisherProvider = {
    info: real.info,
    platform: real.platform,
    transport: real.transport,
    limits: { ...real.limits, maxTextLength: 10 },
    checkAuth: () => real.checkAuth(),
    validate: (v) => real.validate(v),
    publish: (v, o) => real.publish(v, o),
  };
  const report = await runConformance(lying, 'publisher');
  assert.equal(report.passed, false);
  assert.ok(report.checks.some((c) => !c.ok && /maxTextLength/.test(c.name)));
});

test('suite rejects a provider with a mismatched slot', async () => {
  const p = new DryRunPublisher({ outDir: outDir() });
  const report = await runConformance(p, 'source');
  assert.equal(report.passed, false);
});

function failure(report: { checks: { ok: boolean; name: string; detail?: string }[] }): string {
  return report.checks
    .filter((c) => !c.ok)
    .map((c) => `${c.name}: ${c.detail}`)
    .join('\n');
}
