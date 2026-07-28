import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditJson, redactText, sanitizeArgs } from './audit';

test('drops values under credential-shaped keys', () => {
  const out = sanitizeArgs({
    chatId: '-100123',
    token: 'BOT:super-secret-value',
    apiKey: 'sk-live-abc',
    Cookie: 'session=zzz',
    nested: { access_token: 'zzz', platform: 'xiaohongshu' },
  }) as any;

  assert.equal(out.chatId, '-100123');
  assert.equal(out.token, '[redacted]');
  assert.equal(out.apiKey, '[redacted]');
  assert.equal(out.Cookie, '[redacted]');
  assert.equal(out.nested.access_token, '[redacted]');
  assert.equal(out.nested.platform, 'xiaohongshu');

  // The real test: the secret must not survive anywhere in the serialized form.
  assert.ok(!auditJson({ token: 'BOT:super-secret-value' }).includes('super-secret'));
});

test('redacts a whole subtree when the key itself looks like a credential', () => {
  const out = sanitizeArgs({ auth: { token: 'x', user: 'jason' } }) as any;
  assert.equal(out.auth, '[redacted]');
});

test('summarizes post bodies instead of storing them twice', () => {
  const body = '一'.repeat(4000);
  const out = sanitizeArgs({ body, title: '标题' }) as any;

  assert.match(out.body, /\[4000 chars\]$/);
  assert.ok(out.body.length < 200);
  assert.equal(out.title, '标题');
});

test('caps arrays, key counts and nesting depth', () => {
  const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
  const out = sanitizeArgs({ list: Array.from({ length: 25 }, (_, i) => i), many }) as any;

  assert.equal(out.list.length, 11);
  assert.equal(out.list[10], '[+15 more]');
  assert.equal(Object.keys(out.many).length, 21);
  assert.equal(out.many['…'], '[+10 more keys]');

  const deep = sanitizeArgs({ a: { b: { c: { d: { e: 'too far' } } } } }) as any;
  assert.equal(deep.a.b.c.d, '[nested]');
});

test('redactText strips credentials out of free-form error messages', () => {
  assert.equal(
    redactText('xhs failed: --token=abc123def --user jason'),
    'xhs failed: --token=[redacted] --user jason',
  );
  assert.equal(redactText('sent Authorization: Bearer eyJhbGciOi.J9'), 'sent Authorization=[redacted]');
  assert.equal(
    redactText('POST https://api.telegram.org/bot123456:AAH-xyz/sendMessage failed'),
    'POST https://api.telegram.org/bot[redacted]/sendMessage failed',
  );
  assert.equal(redactText('plain failure, nothing to hide'), 'plain failure, nothing to hide');
});

test('leaves ordinary scalars intact', () => {
  const out = sanitizeArgs({ n: 3, ok: false, missing: null, when: new Date(0) }) as any;
  assert.equal(out.n, 3);
  assert.equal(out.ok, false);
  assert.equal(out.missing, null);
  assert.equal(out.when, '1970-01-01T00:00:00.000Z');
});
