import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoffMs, idempotencyKey, newId, payloadHash } from './identity';

test('idempotencyKey is stable across replays', () => {
  const input = { accountId: 'acc_1', draftVariantId: 'dv_1', scheduledFor: 1_700_000_000_000 };
  assert.equal(idempotencyKey(input), idempotencyKey({ ...input }));
});

test('idempotencyKey separates account, variant and slot', () => {
  const base = { accountId: 'acc_1', draftVariantId: 'dv_1', scheduledFor: 1000 };
  const keys = new Set([
    idempotencyKey(base),
    idempotencyKey({ ...base, accountId: 'acc_2' }),
    idempotencyKey({ ...base, draftVariantId: 'dv_2' }),
    idempotencyKey({ ...base, scheduledFor: 2000 }),
  ]);
  assert.equal(keys.size, 4);
});

test('idempotencyKey does not collide when fields are concatenated ambiguously', () => {
  // 'ab'+'c' vs 'a'+'bc' must not hash the same.
  const a = idempotencyKey({ accountId: 'ab', draftVariantId: 'c', scheduledFor: 0 });
  const b = idempotencyKey({ accountId: 'a', draftVariantId: 'bc', scheduledFor: 0 });
  assert.notEqual(a, b);
});

test('payloadHash ignores property order', () => {
  assert.equal(
    payloadHash({ body: 'hello', title: 'x', media: [{ kind: 'image', path: '/a' }] }),
    payloadHash({ media: [{ path: '/a', kind: 'image' }], title: 'x', body: 'hello' }),
  );
});

test('payloadHash detects any content change', () => {
  const original = { body: 'hello world', title: 'x' };
  assert.notEqual(payloadHash(original), payloadHash({ ...original, body: 'hello worId' }));
});

test('payloadHash respects array order', () => {
  assert.notEqual(payloadHash({ tags: ['a', 'b'] }), payloadHash({ tags: ['b', 'a'] }));
});

test('backoff sequence is 1min / 5min / 25min then dead', () => {
  assert.equal(backoffMs(1), 60_000);
  assert.equal(backoffMs(2), 300_000);
  assert.equal(backoffMs(3), 1_500_000);
  assert.equal(backoffMs(4), null, 'attempt beyond budget must dead-letter');
  assert.equal(backoffMs(0), null, 'attempt is 1-based');
});

test('newId is prefixed and unique', () => {
  const ids = new Set(Array.from({ length: 500 }, () => newId('post')));
  assert.equal(ids.size, 500);
  assert.ok([...ids].every((id) => id.startsWith('post_')));
});
