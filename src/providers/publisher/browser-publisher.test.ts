import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  BrowserPublisher,
  UPLOAD_PROFILE_TEMPLATES,
  missingSelectors,
  type UploadProfile,
} from './browser-publisher';
import type { BrowserSession } from '../../core/browser';
import { CredentialStore } from '../../core/credentials';
import { runConformance } from '../../testing/conformance';
import { ProviderError, type DraftVariant } from '../../contracts';

/** Records what the publisher did to the page so tests can assert on the flow. */
function fakeSession(opts: { publishSucceeds?: boolean; loggedIn?: boolean } = {}) {
  const actions: string[] = [];
  const page = {
    goto: async (url: string) => actions.push(`goto:${url}`),
    setInputFiles: async (sel: string, files: string[]) =>
      actions.push(`files:${sel}:${files.length}`),
    fill: async (sel: string, value: string) => actions.push(`fill:${sel}:${value}`),
    click: async (sel: string) => actions.push(`click:${sel}`),
    waitForSelector: async (sel: string) => {
      actions.push(`wait:${sel}`);
      if (opts.publishSucceeds === false) throw new Error('Timeout waiting for selector');
    },
    url: () => 'https://platform/post/123',
    locator: () => ({ count: async () => (opts.loggedIn === false ? 0 : 1) }),
    close: async () => {},
  };

  const session = {
    open: async () => ({ newPage: async () => page }),
    check: async () => (opts.loggedIn === false ? { ok: false, reason: 'session expired' } : { ok: true }),
    close: async () => {},
  } as unknown as BrowserSession;

  return { session, actions };
}

function mediaFile(name = 'clip.mp4'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediabot-bp-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, 'x');
  return p;
}

function profile(over: Partial<UploadProfile> = {}): UploadProfile {
  return {
    platform: 'testplat',
    uploadUrl: 'https://platform/upload',
    loginUrl: 'https://platform/',
    selectors: {
      fileInput: '#file',
      titleInput: '#title',
      bodyInput: '#body',
      publishButton: '#publish',
      successIndicator: '.published',
    },
    limits: { maxTextLength: 500, maxTitleLength: 30, supportsScheduling: false },
    verified: true,
    ...over,
  };
}

function variant(over: Partial<DraftVariant> = {}): DraftVariant {
  return {
    id: 'dv_1',
    platform: 'testplat',
    title: '标题',
    body: '正文',
    media: [{ kind: 'video', path: mediaFile() }],
    ...over,
  };
}

test('an unverified profile refuses to publish, with instructions', async () => {
  const { session, actions } = fakeSession();
  const p = new BrowserPublisher({ profile: profile({ verified: false }), session });

  await assert.rejects(p.publish(variant(), { accountId: 'a' }), (err: unknown) => {
    assert.ok(err instanceof ProviderError);
    assert.equal(err.code, 'misconfigured');
    assert.equal(err.retryable, false);
    assert.match(err.message, /unverified/);
    assert.match(err.message, /https:\/\/platform\/upload/, 'says where to check');
    return true;
  });
  assert.deepEqual(actions, [], 'nothing may touch the page while selectors are unproven');
});

test('an unverified profile warns during validation instead of failing silently', async () => {
  const { session } = fakeSession();
  const p = new BrowserPublisher({ profile: profile({ verified: false }), session });

  const res = await p.validate(variant());
  assert.equal(res.ok, true, 'the content itself is fine');
  assert.ok(res.warnings.some((w) => w.code === 'profile_unverified'));
});

test('a verified profile drives the full upload flow in order', async () => {
  const { session, actions } = fakeSession();
  const p = new BrowserPublisher({ profile: profile(), session });

  const res = await p.publish(variant(), { accountId: 'a' });

  assert.deepEqual(actions, [
    'goto:https://platform/upload',
    'files:#file:1',
    'fill:#title:标题',
    'fill:#body:正文',
    'click:#publish',
    'wait:.published',
  ]);
  assert.equal(res.url, 'https://platform/post/123');
});

test('publish fails when the success indicator never appears', async () => {
  const { session } = fakeSession({ publishSucceeds: false });
  const p = new BrowserPublisher({ profile: profile(), session });

  await assert.rejects(p.publish(variant(), { accountId: 'a' }), (err: unknown) => {
    assert.match((err as Error).message, /upload failed/);
    return true;
  });
});

test('a swallowed click is not reported as a published post', async () => {
  // The publish button click "succeeds" but nothing confirms — the common
  // failure where a validation toast blocks submission.
  const { session } = fakeSession({ publishSucceeds: false });
  const p = new BrowserPublisher({ profile: profile(), session });
  await assert.rejects(
    p.publish(variant(), { accountId: 'a' }),
    'success must be observed, never assumed from the click',
  );
});

test('dry run touches neither browser nor page', async () => {
  const { session, actions } = fakeSession();
  const p = new BrowserPublisher({ profile: profile(), session });

  const res = await p.publish(variant(), { accountId: 'a', dryRun: true });
  assert.deepEqual(actions, []);
  assert.match(res.platformPostId, /^dryrun_/);
});

test('validation requires media because the flow starts from a file', async () => {
  const { session } = fakeSession();
  const p = new BrowserPublisher({ profile: profile(), session });

  const res = await p.validate(variant({ media: [] }));
  assert.deepEqual(res.errors.map((e) => e.code), ['media_required']);
});

test('validation catches missing files and oversized video', async () => {
  const { session } = fakeSession();
  const withVideo = profile({
    limits: {
      maxTextLength: 500,
      video: { maxSeconds: 60, maxBytes: 10, formats: ['mp4'] },
      supportsScheduling: false,
    },
  });
  const p = new BrowserPublisher({ profile: withVideo, session });

  const missing = await p.validate(variant({ media: [{ kind: 'video', path: '/tmp/gone.mp4' }] }));
  assert.deepEqual(missing.errors.map((e) => e.code), ['media_missing']);

  const big = await p.validate(
    variant({ media: [{ kind: 'video', path: mediaFile(), bytes: 999, durationSeconds: 120 }] }),
  );
  assert.deepEqual(big.errors.map((e) => e.code).sort(), ['video_too_large', 'video_too_long']);

  const wrongFormat = await p.validate(variant({ media: [{ kind: 'video', path: mediaFile('a.avi') }] }));
  assert.ok(wrongFormat.errors.some((e) => e.code === 'unsupported_video_format'));
});

test('checkAuth surfaces an expired session', async () => {
  const { session } = fakeSession({ loggedIn: false });
  const p = new BrowserPublisher({ profile: profile(), session });

  const auth = await p.checkAuth();
  assert.equal(auth.ok, false);
  assert.match(auth.reason!, /expired/);
});

test('every shipped template is unverified and says where to edit it', () => {
  // Some templates now carry observed selectors, so "has gaps" is no longer
  // universal — but shipping unverified is, and that is the invariant that
  // actually protects the account.
  for (const [name, tpl] of Object.entries(UPLOAD_PROFILE_TEMPLATES)) {
    assert.equal(
      tpl.verified,
      false,
      `${name} must ship unverified until someone watches it publish`,
    );
    assert.ok(tpl.source, `${name} should say where to edit it`);
  }
});

test('missingSelectors reports nothing once a profile is filled in', () => {
  assert.deepEqual(missingSelectors(profile()), []);
  assert.deepEqual(
    missingSelectors(profile({ selectors: { ...profile().selectors, publishButton: '' } })),
    ['publishButton'],
  );
});

test('passes the publisher conformance suite', async () => {
  const { session } = fakeSession();
  const p = new BrowserPublisher({ profile: profile(), session });
  const report = await runConformance(p, 'publisher');

  // The probe variant carries no media, which this transport legitimately
  // rejects; everything else must pass.
  const relevant = report.checks.filter((c) => !/validate accepts a compliant variant/.test(c.name));
  assert.ok(
    relevant.every((c) => c.ok),
    relevant.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('\n'),
  );
});

test('the session is scoped per platform and account', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mediabot-bp-'));
  const credentials = new CredentialStore({ home, backend: 'file' });
  const a = new BrowserPublisher({ profile: profile(), account: 'one', credentials });
  const b = new BrowserPublisher({ profile: profile(), account: 'two', credentials });
  assert.notEqual((a as any).session.stateKey, (b as any).session.stateKey);
});

test('a url: success indicator waits for navigation, not an element', async () => {
  const waited: string[] = [];
  const page = {
    goto: async () => {},
    setInputFiles: async () => {},
    fill: async () => {},
    click: async () => {},
    waitForURL: async (glob: string) => waited.push(`url:${glob}`),
    waitForSelector: async (sel: string) => waited.push(`sel:${sel}`),
    url: () => 'https://platform/publish/success?id=1',
    locator: () => ({ count: async () => 1 }),
    close: async () => {},
  };
  const session = {
    open: async () => ({ newPage: async () => page }),
    check: async () => ({ ok: true }),
    close: async () => {},
  } as unknown as BrowserSession;

  const p = new BrowserPublisher({
    profile: profile({
      selectors: { ...profile().selectors, successIndicator: 'url:**/publish/success?**' },
    }),
    session,
  });
  await p.publish(variant(), { accountId: 'a' });

  assert.deepEqual(
    waited,
    ['url:**/publish/success?**'],
    'XHS and Channels confirm by navigating; waiting for an element would time out',
  );
});

test('a plain selector indicator still waits for the element', async () => {
  const waited: string[] = [];
  const page = {
    goto: async () => {},
    setInputFiles: async () => {},
    fill: async () => {},
    click: async () => {},
    waitForURL: async (g: string) => waited.push(`url:${g}`),
    waitForSelector: async (s: string) => waited.push(`sel:${s}`),
    url: () => 'https://platform/x',
    locator: () => ({ count: async () => 1 }),
    close: async () => {},
  };
  const session = {
    open: async () => ({ newPage: async () => page }),
    check: async () => ({ ok: true }),
    close: async () => {},
  } as unknown as BrowserSession;

  await new BrowserPublisher({ profile: profile(), session }).publish(variant(), { accountId: 'a' });
  assert.deepEqual(waited, ['sel:.published']);
});

test('a loggedOutIndicator inverts the auth check', async () => {
  const make = (loginBoxCount: number) => {
    const page = {
      goto: async () => {},
      locator: () => ({ count: async () => loginBoxCount }),
      close: async () => {},
      url: () => 'https://platform/',
    };
    return {
      open: async () => ({ newPage: async () => page }),
      // Delegate to the publisher's own probe rather than short-circuiting.
      check: async (probe: any) => {
        const ok = await probe.isLoggedIn(page);
        return ok ? { ok: true } : { ok: false, reason: 'session expired' };
      },
      close: async () => {},
    } as unknown as BrowserSession;
  };

  const withOut = profile({
    selectors: { ...profile().selectors, loggedOutIndicator: 'div.login-box' },
  });

  assert.equal(
    (await new BrowserPublisher({ profile: withOut, session: make(0) }).checkAuth()).ok,
    true,
    'no login box present means we are signed in',
  );
  assert.equal(
    (await new BrowserPublisher({ profile: withOut, session: make(1) }).checkAuth()).ok,
    false,
    'the login box is conclusive evidence of being signed out',
  );
});

test('the observed profiles carry real selectors but stay unverified', () => {
  for (const name of ['xiaohongshu-video', 'wechat-channels']) {
    const tpl = UPLOAD_PROFILE_TEMPLATES[name]!;
    assert.deepEqual(missingSelectors(tpl), [], `${name} should have every required selector filled`);
    assert.ok(
      tpl.selectors.successIndicator.startsWith('url:'),
      `${name} confirms by navigation`,
    );
    assert.equal(
      tpl.verified,
      false,
      `${name} must still ship unverified — "looks right" is not "watched it work"`,
    );
  }
});

test('platforms with no observed selectors still report what they need', () => {
  for (const name of ['douyin', 'kuaishou']) {
    assert.ok(missingSelectors(UPLOAD_PROFILE_TEMPLATES[name]!).length > 0);
  }
});
