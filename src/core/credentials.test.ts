import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CredentialStore, isSecretRef, refName, secretRef } from './credentials';

function fileStore() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mediabot-cred-'));
  return { home, store: new CredentialStore({ home, backend: 'file' }) };
}

test('stores and retrieves a secret, returning an opaque reference', async () => {
  const { store } = fileStore();
  const ref = await store.set('telegram', 'BOT:super-secret-token');

  assert.equal(ref, 'secret:telegram');
  assert.equal(await store.get('telegram'), 'BOT:super-secret-token');
});

test('the secret never appears in plaintext on disk', async () => {
  const { home, store } = fileStore();
  await store.set('telegram', 'BOT:super-secret-token');

  for (const f of fs.readdirSync(home)) {
    const contents = fs.readFileSync(path.join(home, f), 'utf8');
    assert.ok(
      !contents.includes('BOT:super-secret-token'),
      `secret found in plaintext inside ${f} — the whole point is that it is not there`,
    );
  }
});

test('the vault and key files are owner-only', async () => {
  const { home, store } = fileStore();
  await store.set('a', 'b');

  for (const f of ['secrets.enc', 'secrets.key']) {
    const mode = fs.statSync(path.join(home, f)).mode & 0o777;
    assert.equal(mode, 0o600, `${f} should be 0600, got ${mode.toString(8)}`);
  }
});

test('overwriting a secret replaces it', async () => {
  const { store } = fileStore();
  await store.set('k', 'first');
  await store.set('k', 'second');
  assert.equal(await store.get('k'), 'second');
});

test('several secrets coexist in one vault', async () => {
  const { store } = fileStore();
  await store.set('a', '1');
  await store.set('b', '2');
  assert.equal(await store.get('a'), '1');
  assert.equal(await store.get('b'), '2');
});

test('removing a secret leaves the others intact', async () => {
  const { store } = fileStore();
  await store.set('a', '1');
  await store.set('b', '2');
  await store.remove('a');

  assert.equal(await store.get('a'), null);
  assert.equal(await store.get('b'), '2');
});

test('a missing secret resolves to null rather than throwing', async () => {
  const { store } = fileStore();
  assert.equal(await store.get('never-set'), null);
});

test('a tampered vault is rejected instead of yielding garbage', async () => {
  const { home, store } = fileStore();
  await store.set('k', 'v');

  const p = path.join(home, 'secrets.enc');
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  // Flip a byte of the ciphertext; GCM's auth tag must catch it.
  raw.data = raw.data.slice(0, -2) + (raw.data.endsWith('00') ? '11' : '00');
  fs.writeFileSync(p, JSON.stringify(raw));

  await assert.rejects(async () => store.get('k'), 'authenticated encryption must reject tampering');
});

test('resolve passes plain values through unchanged', async () => {
  const { store } = fileStore();
  assert.equal(await store.resolve('literal-token'), 'literal-token');
  assert.equal(await store.resolve(undefined), undefined);
});

test('resolve substitutes a stored secret for its reference', async () => {
  const { store } = fileStore();
  const ref = await store.set('hook', 'Bearer abc123');
  assert.equal(await store.resolve(ref), 'Bearer abc123');
});

test('a reference with no stored secret resolves to undefined, not the ref string', async () => {
  const { store } = fileStore();
  assert.equal(
    await store.resolve('secret:missing'),
    undefined,
    'returning the literal "secret:missing" would be sent as if it were the token',
  );
});

test('resolveAll handles a mixed object', async () => {
  const { store } = fileStore();
  await store.set('tok', 'real-token');

  assert.deepEqual(
    await store.resolveAll({
      telegramBotToken: 'secret:tok',
      telegramChatId: '12345',
      missing: undefined,
    }),
    { telegramBotToken: 'real-token', telegramChatId: '12345', missing: undefined },
  );
});

test('reference helpers round-trip', () => {
  assert.equal(secretRef('x'), 'secret:x');
  assert.ok(isSecretRef('secret:x'));
  assert.ok(!isSecretRef('plain'));
  assert.equal(refName('secret:x'), 'x');
  assert.equal(refName('plain'), 'plain');
});

test('a fresh store reads secrets written by a previous instance', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mediabot-cred-'));
  await new CredentialStore({ home, backend: 'file' }).set('k', 'persisted');
  assert.equal(await new CredentialStore({ home, backend: 'file' }).get('k'), 'persisted');
});

test('macOS defaults to the keychain backend', () => {
  const expected = process.platform === 'darwin' ? 'keychain' : 'file';
  assert.equal(new CredentialStore().backendName, expected);
});
