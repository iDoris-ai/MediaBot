import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BrowserSession, type BrowserLauncher, type LoginProbe } from './browser';
import { CredentialStore } from './credentials';
import { ProviderError } from '../contracts';

/**
 * The stand-in cookie value.
 *
 * It must contain characters that cannot appear in the encrypted blob, which
 * is stored as hex. The old value was 'abc' — three hex digits — so the
 * "never on disk in plaintext" assertion matched at random inside perfectly
 * good ciphertext and failed roughly one run in a hundred. A security check
 * that cries wolf gets muted, so the sentinel is now unmistakable.
 */
const COOKIE_SENTINEL = 'session-cookie-plaintext-sentinel-ZZZ';

/**
 * A fake Playwright surface. Real browsers are exercised by the live check in
 * the commit message, not by the suite — CI must stay browser-free.
 */
function fakeLauncher(opts: { loggedIn?: boolean | (() => boolean); gotoFails?: boolean } = {}) {
  const state = { closed: false, savedState: { cookies: [{ name: 'session', value: COOKIE_SENTINEL }] } };
  const pages: any[] = [];

  const page = () => {
    const p = {
      goto: async () => {
        if (opts.gotoFails) throw new Error('net::ERR_CONNECTION_REFUSED');
      },
      waitForTimeout: async () => {},
      close: async () => {},
    };
    pages.push(p);
    return p;
  };

  const context = {
    setDefaultTimeout: () => {},
    newPage: async () => page(),
    storageState: async () => state.savedState,
    close: async () => {},
  };

  const launcher: BrowserLauncher & { seen: any } = {
    seen: { headless: undefined as boolean | undefined, storageState: undefined as any },
    launch: async ({ headless }) => {
      launcher.seen.headless = headless;
      return {
        newContext: async (o: any) => {
          launcher.seen.storageState = o?.storageState;
          return context;
        },
        close: async () => {
          state.closed = true;
        },
      } as any;
    },
  };

  const probe: LoginProbe = {
    url: 'https://example.com/me',
    isLoggedIn: async () =>
      typeof opts.loggedIn === 'function' ? opts.loggedIn() : (opts.loggedIn ?? true),
  };

  return { launcher, probe, state, pages };
}

function creds() {
  return new CredentialStore({
    home: fs.mkdtempSync(path.join(os.tmpdir(), 'mediabot-browser-')),
    backend: 'file',
  });
}

test('a saved session round-trips through the credential store', async () => {
  const c = creds();
  const { launcher } = fakeLauncher();
  const s = new BrowserSession({ account: 'douyin:me', credentials: c, launcher });

  assert.equal(await s.hasSavedState(), false);
  await s.open();
  await s.save();
  assert.equal(await s.hasSavedState(), true);
  await s.close();

  // A fresh session restores the cookies rather than starting logged out.
  const { launcher: l2 } = fakeLauncher();
  const s2 = new BrowserSession({ account: 'douyin:me', credentials: c, launcher: l2 });
  await s2.open();
  assert.deepEqual((l2 as any).seen.storageState.cookies, [{ name: 'session', value: COOKIE_SENTINEL }]);
  await s2.close();
});

test('login cookies never touch disk in plaintext', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mediabot-browser-'));
  const c = new CredentialStore({ home, backend: 'file' });
  const { launcher } = fakeLauncher();
  const s = new BrowserSession({ account: 'douyin:me', credentials: c, launcher });

  await s.open();
  await s.save();
  await s.close();

  for (const f of fs.readdirSync(home)) {
    const contents = fs.readFileSync(path.join(home, f), 'utf8');
    assert.ok(
      !contents.includes(COOKIE_SENTINEL),
      `cookie value found in plaintext in ${f} — a session cookie is full account control`,
    );
  }
});

test('check reports not-logged-in when nothing was ever saved', async () => {
  const { launcher, probe } = fakeLauncher();
  const s = new BrowserSession({ account: 'a', credentials: creds(), launcher });

  const res = await s.check(probe);
  assert.equal(res.ok, false);
  assert.match(res.reason!, /no saved session/);
});

test('check succeeds when the probe says we are logged in', async () => {
  const c = creds();
  const { launcher, probe } = fakeLauncher({ loggedIn: true });
  const s = new BrowserSession({ account: 'a', credentials: c, launcher });

  await s.open();
  await s.save();
  assert.deepEqual(await s.check(probe), { ok: true });
  await s.close();
});

test('an expired session is reported, not thrown', async () => {
  const c = creds();
  const { launcher, probe } = fakeLauncher({ loggedIn: false });
  const s = new BrowserSession({ account: 'a', credentials: c, launcher });

  await s.open();
  await s.save();
  const res = await s.check(probe);

  assert.equal(res.ok, false);
  assert.match(res.reason!, /expired/, 'the caller marks the account needs_reauth and moves on');
  await s.close();
});

test('a navigation failure during check is reported rather than crashing the tick', async () => {
  const c = creds();
  const { launcher, probe } = fakeLauncher({ gotoFails: true });
  const s = new BrowserSession({ account: 'a', credentials: c, launcher });

  await s.open();
  await s.save();
  const res = await s.check(probe);

  assert.equal(res.ok, false);
  assert.match(res.reason!, /ERR_CONNECTION_REFUSED/);
  await s.close();
});

test('corrupt saved state is discarded instead of wedging every run', async () => {
  const c = creds();
  const s = new BrowserSession({ account: 'a', credentials: c, launcher: fakeLauncher().launcher });
  await c.set(s.stateKey, 'this is not json');

  await s.open(); // must not throw
  assert.equal(await c.get(s.stateKey), null, 'the bad blob is cleared so the user can re-login');
  await s.close();
});

test('interactive login is refused in headless mode', async () => {
  const { launcher, probe } = fakeLauncher();
  const s = new BrowserSession({ account: 'a', credentials: creds(), launcher, headless: true });

  await assert.rejects(s.login(probe), (err: unknown) => {
    assert.ok(err instanceof ProviderError);
    assert.match(err.message, /visible browser/);
    return true;
  });
});

test('interactive login saves the session once the probe passes', async () => {
  const c = creds();
  let attempts = 0;
  const { launcher, probe } = fakeLauncher({ loggedIn: () => ++attempts >= 2 });
  const s = new BrowserSession({ account: 'a', credentials: c, launcher, headless: false });

  await s.login(probe, 10_000);

  assert.equal(await s.hasSavedState(), true);
  assert.equal((launcher as any).seen.headless, false, 'QR and SMS logins need a visible window');
  await s.close();
});

test('a login that is never completed times out', async () => {
  const { launcher, probe } = fakeLauncher({ loggedIn: false });
  const s = new BrowserSession({ account: 'a', credentials: creds(), launcher, headless: false });

  await assert.rejects(s.login(probe, 100), /not completed in time/);
  await s.close();
});

test('clear forgets the session', async () => {
  const c = creds();
  const { launcher } = fakeLauncher();
  const s = new BrowserSession({ account: 'a', credentials: c, launcher });

  await s.open();
  await s.save();
  await s.clear();
  assert.equal(await s.hasSavedState(), false);
  await s.close();
});

test('sessions for different accounts do not collide', async () => {
  const c = creds();
  const a = new BrowserSession({ account: 'douyin:one', credentials: c, launcher: fakeLauncher().launcher });
  const b = new BrowserSession({ account: 'douyin:two', credentials: c, launcher: fakeLauncher().launcher });

  assert.notEqual(a.stateKey, b.stateKey);
  await a.open();
  await a.save();
  assert.equal(await b.hasSavedState(), false);
  await a.close();
});

test('open is idempotent within a session', async () => {
  const { launcher } = fakeLauncher();
  const s = new BrowserSession({ account: 'a', credentials: creds(), launcher });
  assert.equal(await s.open(), await s.open());
  await s.close();
});
