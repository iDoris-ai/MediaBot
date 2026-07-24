import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cronMatches, parseCron, Scheduler } from './scheduler';

const at = (s: string) => new Date(s);

test('matches wildcards, exact values, lists, ranges and steps', () => {
  const t = at('2026-07-24T08:30:00');
  assert.ok(cronMatches('* * * * *', t));
  assert.ok(cronMatches('30 8 * * *', t));
  assert.ok(cronMatches('0,30 8 * * *', t));
  assert.ok(cronMatches('30 6-9 * * *', t));
  assert.ok(cronMatches('*/30 * * * *', t));
  assert.ok(!cronMatches('31 8 * * *', t));
  assert.ok(!cronMatches('30 9 * * *', t));
});

test('matches day of week', () => {
  const friday = at('2026-07-24T08:00:00');
  assert.equal(friday.getDay(), 5);
  assert.ok(cronMatches('0 8 * * 5', friday));
  assert.ok(cronMatches('0 8 * * 1-5', friday));
  assert.ok(!cronMatches('0 8 * * 0', friday));
});

test('rejects malformed expressions at parse time', () => {
  assert.throws(() => parseCron('* * * *'), /5 fields/);
  assert.throws(() => parseCron('60 * * * *'), /out of range/);
  assert.throws(() => parseCron('* 24 * * *'), /out of range/);
  assert.throws(() => parseCron('*/0 * * * *'), /step/);
  assert.throws(() => parseCron('abc * * * *'), /bad cron value/);
});

test('a job fires once per matching minute, not once per tick', async () => {
  let now = at('2026-07-24T08:00:00');
  let runs = 0;
  const s = new Scheduler({ now: () => now }).add({
    name: 'poll',
    cron: '* * * * *',
    run: async () => {
      runs += 1;
    },
  });

  await s.tick();
  await s.tick();
  await s.tick();
  assert.equal(runs, 1, 'three ticks inside one minute must fire once');

  now = at('2026-07-24T08:01:00');
  await s.tick();
  assert.equal(runs, 2);
});

test('a slow job is never started concurrently with itself', async () => {
  let now = at('2026-07-24T08:00:00');
  let active = 0;
  let maxActive = 0;

  const s = new Scheduler({ now: () => now }).add({
    name: 'slow',
    cron: '* * * * *',
    run: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 30));
      active -= 1;
    },
  });

  const first = s.tick();
  now = at('2026-07-24T08:01:00');
  await s.tick();
  await first;

  assert.equal(maxActive, 1, 'a publish still in flight must not be re-entered');
});

test('a throwing job is reported but does not stop the others', async () => {
  const errors: string[] = [];
  let goodRuns = 0;
  const s = new Scheduler({
    now: () => at('2026-07-24T08:00:00'),
    onError: (job) => errors.push(job),
  })
    .add({
      name: 'bad',
      cron: '* * * * *',
      run: async () => {
        throw new Error('boom');
      },
    })
    .add({
      name: 'good',
      cron: '* * * * *',
      run: async () => {
        goodRuns += 1;
      },
    });

  await s.tick();
  assert.deepEqual(errors, ['bad']);
  assert.equal(goodRuns, 1, 'a failing job must not block the rest of the schedule');
});

test('add validates the cron up front', () => {
  const s = new Scheduler();
  assert.throws(() => s.add({ name: 'x', cron: 'nope', run: async () => {} }));
});
