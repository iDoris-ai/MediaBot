import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RedditSource } from './reddit';
import { RedditEngagement, flattenComments } from '../engagement/reddit';
import { runConformance } from '../../testing/conformance';
import { ProviderError } from '../../contracts';
import type { CliRunner } from '../../core/cli-adapter';

function listing(posts: any[]) {
  return { ok: true, data: { kind: 'Listing', data: { children: posts.map((data) => ({ data })) } } };
}

const POSTS = [
  {
    id: 'p1',
    title: 'How do you automate posting?',
    selftext: 'Looking for something self-hosted.',
    permalink: '/r/selfhosted/comments/p1/how_do_you/',
    score: 240,
    subreddit: 'selfhosted',
    author: 'someone',
    created_utc: 1_790_000_000,
  },
  { id: 'p2', title: 'Weekly thread', permalink: '/r/x/comments/p2/', score: 12, created_utc: 1_780_000_000 },
  { id: 'broken', selftext: 'no title here' },
];

const OK_STATUS = { ok: true, data: { authenticated: true } };

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

test('maps Reddit search results into namespaced items', async () => {
  const s = new RedditSource({ runner: runner({ search: listing(POSTS) }) });
  const items = await s.fetch({ keywords: ['automate posting'] });

  assert.deepEqual(items.map((i) => i.id), ['reddit:p1', 'reddit:p2']);
  assert.equal(items[0]!.title, 'How do you automate posting?');
  assert.equal(items[0]!.url, 'https://www.reddit.com/r/selfhosted/comments/p1/how_do_you/');
  assert.equal(items[0]!.score, 240);
  assert.match(items[0]!.summary!, /self-hosted/);
});

test('a post without a title is skipped', async () => {
  const s = new RedditSource({ runner: runner({ search: listing(POSTS) }) });
  const items = await s.fetch({ keywords: ['x'] });
  assert.ok(!items.some((i) => i.id.endsWith('broken')));
});

test('ids are stable across polls', async () => {
  const s = new RedditSource({ runner: runner({ search: listing(POSTS) }) });
  const a = (await s.fetch({ keywords: ['x'] })).map((i) => i.id);
  const b = (await s.fetch({ keywords: ['x'] })).map((i) => i.id);
  assert.deepEqual(a, b);
});

test('subreddits are searched individually and results deduped', async () => {
  const calls: string[][] = [];
  const s = new RedditSource({
    runner: runner({ search: listing(POSTS) }, calls),
    subreddits: ['selfhosted', 'SaaS'],
  });

  const items = await s.fetch({ keywords: ['automate'] });

  assert.equal(calls.length, 2);
  assert.equal(calls[0]![calls[0]!.indexOf('-r') + 1], 'selfhosted');
  assert.equal(calls[1]![calls[1]!.indexOf('-r') + 1], 'SaaS');
  assert.equal(new Set(items.map((i) => i.id)).size, items.length, 'the same post found twice appears once');
});

test('a global search runs when no subreddits are configured', async () => {
  const calls: string[][] = [];
  const s = new RedditSource({ runner: runner({ search: listing(POSTS) }, calls) });
  await s.fetch({ keywords: ['x'] });
  assert.ok(!calls[0]!.includes('-r'));
});

test('since filters older threads', async () => {
  const s = new RedditSource({ runner: runner({ search: listing(POSTS) }) });
  const items = await s.fetch({ keywords: ['x'], since: new Date(1_785_000_000_000) });
  assert.deepEqual(items.map((i) => i.id), ['reddit:p1']);
});

test('an expired login stops the sweep instead of returning silence', async () => {
  const dead: CliRunner = async () => {
    throw new ProviderError('please log in', 'auth_expired', false);
  };
  const s = new RedditSource({ runner: dead });
  await assert.rejects(s.fetch({ keywords: ['x'] }), (err: unknown) => {
    assert.equal((err as ProviderError).code, 'auth_expired');
    return true;
  });
});

test('one failing keyword does not lose the others', async () => {
  let call = 0;
  const flaky: CliRunner = async (_b, args) => {
    if (args[0] === 'status') return { stdout: JSON.stringify(OK_STATUS), stderr: '' };
    call += 1;
    if (call === 1) throw new ProviderError('rate limited', 'rate_limited', true);
    return { stdout: JSON.stringify(listing(POSTS)), stderr: '' };
  };
  const s = new RedditSource({ runner: flaky });
  assert.equal((await s.fetch({ keywords: ['bad', 'good'] })).length, 2);
});

test('no keywords means no search', async () => {
  const calls: string[][] = [];
  const s = new RedditSource({ runner: runner({ search: listing(POSTS) }, calls) });
  assert.deepEqual(await s.fetch({}), []);
  assert.equal(calls.length, 0);
});

test('healthCheck reports login state', async () => {
  assert.deepEqual(await new RedditSource({ runner: runner({ status: OK_STATUS }) }).healthCheck(), {
    ok: true,
  });
  const anon = new RedditSource({ runner: runner({ status: { ok: true, data: { authenticated: false } } }) });
  assert.match((await anon.healthCheck()).detail!, /rdt login/);
});

test('source passes the conformance suite, including eyes-not-hands', async () => {
  const s = new RedditSource({
    runner: runner({ status: OK_STATUS, search: listing(POSTS) }),
    keywords: ['automate'],
  });
  const report = await runConformance(s, 'source');
  assert.ok(report.passed, report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('\n'));
});

// --- engagement -----------------------------------------------------------

test('the engagement provider exposes no upvote method', () => {
  const e = new RedditEngagement();
  assert.equal(
    typeof (e as any).upvote,
    'undefined',
    'rdt can vote; automated voting is vote manipulation even from one account',
  );
  assert.equal(typeof (e as any).vote, 'undefined');
});

test('listComments flattens the nested thread', async () => {
  const thread = {
    ok: true,
    data: [
      { kind: 'Listing', data: { children: [{ kind: 't3', data: { id: 'post1' } }] } },
      {
        kind: 'Listing',
        data: {
          children: [
            {
              kind: 't1',
              data: {
                id: 'c1',
                body: 'top level',
                author: 'alice',
                created_utc: 1_790_000_000,
                replies: {
                  kind: 'Listing',
                  data: {
                    children: [
                      { kind: 't1', data: { id: 'c2', body: 'nested', author: 'bob', parent_id: 't1_c1' } },
                      { kind: 'more', data: { count: 12 } },
                    ],
                  },
                },
              },
            },
          ],
        },
      },
    ],
  };

  const e = new RedditEngagement({ runner: runner({ read: thread }) });
  const comments = await e.listComments({ postId: 'p', platformPostId: 'post1', accountId: 'a' });

  assert.deepEqual(comments.map((c) => c.id), ['reddit:c1', 'reddit:c2']);
  assert.equal(comments[1]!.parentId, 'reddit:c1', 'the t1_ prefix is stripped');
});

test('a "more comments" placeholder is not treated as a comment', () => {
  const flat = flattenComments({
    data: { kind: 'Listing', data: { children: [{ kind: 'more', data: { count: 30 } }] } },
  });
  assert.deepEqual(flat, []);
});

test('reply posts to the target and strips the id kind prefix', async () => {
  const calls: string[][] = [];
  const e = new RedditEngagement({
    runner: runner({ comment: { ok: true, data: { name: 't1_new1' } } }, calls),
  });

  const res = await e.reply('reddit:c1', 'here is what worked for us', { accountId: 'a' });

  assert.deepEqual(calls[0]!.slice(0, 3), ['comment', 'c1', 'here is what worked for us']);
  assert.equal(res.platformReplyId, 'new1');
});

test('dry-run reply calls nothing', async () => {
  const calls: string[][] = [];
  const e = new RedditEngagement({ runner: runner({ comment: {} }, calls) });
  await e.reply('reddit:c1', 'hi', { accountId: 'a', dryRun: true });
  assert.equal(calls.length, 0);
});

test('a missing comment id raises a ProviderError', async () => {
  const e = new RedditEngagement({ runner: runner({ comment: { ok: false } }) });
  await assert.rejects(e.reply('reddit:c1', 'x', { accountId: 'a' }), ProviderError);
});

test('engagement passes the conformance suite', async () => {
  const e = new RedditEngagement({ runner: runner({ read: { ok: true, data: [] } }) });
  const report = await runConformance(e, 'engagement');
  assert.ok(report.passed, report.checks.filter((c) => !c.ok).map((c) => c.detail).join('\n'));
});
