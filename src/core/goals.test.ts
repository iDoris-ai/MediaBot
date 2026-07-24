import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GoalStore } from './goals';
import { buildCollectors, localCollectors, type MetricCollector } from './metrics';
import { open } from './db';
import type { CliRunner } from './cli-adapter';

const NOW = 1_800_000_000_000;

/** A collector whose readings the test controls. */
function fixed(metric: string, values: Array<number | null>): MetricCollector {
  let i = 0;
  return {
    metric,
    description: metric,
    collect: async () => {
      const v = values[Math.min(i++, values.length - 1)]!;
      return v === null
        ? { metric, value: null, unavailable: 'platform did not report it', measuredAt: NOW }
        : { metric, value: v, measuredAt: NOW };
    },
  };
}

function store(collectors: MetricCollector[], clock = { t: NOW }) {
  const db = open(':memory:');
  return { db, clock, goals: new GoalStore(db, collectors, () => clock.t) };
}

test('a proposed goal starts in draft with no baseline', () => {
  const { goals } = store([fixed('twitter.followers', [414])]);
  const g = goals.propose({ title: '粉丝 +20%', metric: 'twitter.followers', target: 500 });

  assert.equal(g.state, 'draft');
  assert.equal(g.baseline, null);
  assert.equal(g.target, 500);
});

test('activation is refused without a measured baseline', () => {
  const { goals } = store([fixed('twitter.followers', [414])]);
  const g = goals.propose({ title: '粉丝 +20%', metric: 'twitter.followers', target: 500 });

  assert.throws(
    () => goals.activate(g.id),
    /no measured baseline/,
    'a target against an unmeasured number cannot be reviewed honestly',
  );
});

test('measuring the baseline then activating works', async () => {
  const { goals } = store([fixed('twitter.followers', [414])]);
  const g = goals.propose({ title: '粉丝 +20%', metric: 'twitter.followers', target: 500 });

  const measured = await goals.measureBaseline(g.id);
  assert.equal(measured.error, undefined);
  assert.equal(measured.goal.baseline, 414);
  assert.equal(measured.goal.baselineMeasuredAt, NOW);

  assert.equal(goals.activate(g.id).state, 'active');
});

test('an unavailable metric reports why and leaves the goal unmeasured', async () => {
  const { goals } = store([fixed('xiaohongshu.fans', [null])]);
  const g = goals.propose({ title: '小红书粉丝', metric: 'xiaohongshu.fans', target: 100 });

  const res = await goals.measureBaseline(g.id);
  assert.match(res.error!, /did not report/);
  assert.equal(res.goal.baseline, null);
  assert.throws(() => goals.activate(g.id), /no measured baseline/);
});

test('a metric with no collector is reported rather than defaulted to zero', async () => {
  const { goals } = store([]);
  const g = goals.propose({ title: 'x', metric: 'nowhere.metric', target: 1 });
  const res = await goals.measureBaseline(g.id);
  assert.match(res.error!, /no collector provides/);
  assert.equal(res.goal.baseline, null);
});

test('activation is refused without a target', async () => {
  const { goals } = store([fixed('twitter.followers', [414])]);
  const g = goals.propose({ title: 'no target', metric: 'twitter.followers' });
  await goals.measureBaseline(g.id);
  assert.throws(() => goals.activate(g.id), /no target/);
});

test('progress is measured from baseline toward target', async () => {
  const clock = { t: NOW };
  const { goals } = store([fixed('twitter.followers', [400, 450])], clock);
  const g = goals.propose({ title: '+100', metric: 'twitter.followers', target: 500 });
  await goals.measureBaseline(g.id);
  goals.activate(g.id);

  clock.t += 86_400_000;
  await goals.review(g.id);

  const p = goals.progress(g.id);
  assert.equal(p.latest, 450);
  assert.equal(p.progress, 0.5, '450 is halfway from 400 to 500');
});

test('reaching the target closes the goal', async () => {
  const clock = { t: NOW };
  const { goals } = store([fixed('twitter.followers', [400, 520])], clock);
  const g = goals.propose({ title: '+100', metric: 'twitter.followers', target: 500 });
  await goals.measureBaseline(g.id);
  goals.activate(g.id);

  clock.t += 86_400_000;
  await goals.review(g.id);
  assert.equal(goals.get(g.id)!.state, 'done');
});

test('a downward goal completes when the metric falls to target', async () => {
  const clock = { t: NOW };
  const { goals } = store([fixed('cost.per_post', [100, 40])], clock);
  const g = goals.propose({ title: '降成本', metric: 'cost.per_post', target: 50 });
  await goals.measureBaseline(g.id);
  goals.activate(g.id);

  clock.t += 1000;
  await goals.review(g.id);
  assert.equal(goals.get(g.id)!.state, 'done', 'target below baseline means lower is better');
});

test('passing the deadline without reaching target marks it failed', async () => {
  const clock = { t: NOW };
  const { goals } = store([fixed('twitter.followers', [400, 410])], clock);
  const g = goals.propose({
    title: '+100',
    metric: 'twitter.followers',
    target: 500,
    deadline: new Date(NOW + 1000),
  });
  await goals.measureBaseline(g.id);
  goals.activate(g.id);

  clock.t = NOW + 5000;
  await goals.review(g.id);
  assert.equal(goals.get(g.id)!.state, 'failed');
});

test('predictions are scored against the reading that followed them', async () => {
  const clock = { t: NOW };
  const { goals } = store([fixed('twitter.followers', [400, 450, 460])], clock);
  const g = goals.propose({ title: '+100', metric: 'twitter.followers', target: 900 });
  await goals.measureBaseline(g.id);
  goals.activate(g.id);

  clock.t += 1000;
  await goals.review(g.id, { predictNext: 500 }); // reads 450, forecasts 500

  clock.t += 1000;
  await goals.review(g.id); // reads 460 — the forecast of 500 was 8.7% high

  const p = goals.progress(g.id);
  assert.ok(p.lastPredictionError !== null);
  assert.ok(
    Math.abs(p.lastPredictionError! - Math.abs(460 - 500) / 460) < 1e-9,
    'a stored forecast must be scored, not just recorded',
  );
});

test('an unavailable reading during review is recorded, not treated as zero', async () => {
  const clock = { t: NOW };
  const { goals } = store([fixed('twitter.followers', [400, null])], clock);
  const g = goals.propose({ title: '+100', metric: 'twitter.followers', target: 500 });
  await goals.measureBaseline(g.id);
  goals.activate(g.id);

  clock.t += 1000;
  const check = await goals.review(g.id);

  assert.equal(check.measured, null);
  assert.match(check.note!, /did not report/);
  assert.equal(goals.get(g.id)!.state, 'active', 'a missing reading must not fail the goal');
});

test('local collectors always resolve, giving a usable fallback baseline', async () => {
  const db = open(':memory:');
  const collectors = localCollectors(db, () => NOW);
  const readings = await Promise.all(collectors.map((c) => c.collect()));
  assert.deepEqual(readings.map((r) => r.value), [0, 0, 0]);
  assert.ok(readings.every((r) => r.unavailable === undefined));
});

test('a CLI collector reports unavailable rather than throwing', async () => {
  const dead: CliRunner = async () => {
    throw new Error('twitter CLI missing');
  };
  const [followers] = buildCollectors({ runner: dead, now: () => NOW });
  const reading = await followers!.collect();
  assert.equal(reading.value, null);
  assert.match(reading.unavailable!, /missing/);
});

test('a CLI collector parses the follower count', async () => {
  const runner: CliRunner = async () => ({
    stdout: JSON.stringify({ data: { user: { followers: 414, tweets: 551 } } }),
    stderr: '',
  });
  const [followers, posts] = buildCollectors({ runner, now: () => NOW });
  assert.equal((await followers!.collect()).value, 414);
  assert.equal((await posts!.collect()).value, 551);
});
