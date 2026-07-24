import type { Browser, BrowserContext, Page } from 'playwright';
import { CredentialStore } from './credentials';
import { ProviderError } from '../contracts';

/**
 * Browser sessions for platforms with no API and no CLI.
 *
 * Login state is a bag of cookies that grants full control of the account, so
 * it is stored through the credential store (Keychain / encrypted file) rather
 * than as a JSON file on disk next to the database.
 *
 * The first login must happen with a visible window — these platforms use QR
 * codes and SMS. Afterwards the saved state is replayed headlessly. That is a
 * real deployment constraint, not a preference: a headless VPS cannot complete
 * a first login.
 */

export interface BrowserSessionOptions {
  /** Account key; scopes the stored state. */
  account: string;
  credentials?: CredentialStore;
  headless?: boolean;
  /** Injected in tests so no real browser launches. */
  launcher?: BrowserLauncher;
  timeoutMs?: number;
  userAgent?: string;
}

/** Just enough of Playwright's surface to be substitutable in tests. */
export interface BrowserLauncher {
  launch(opts: { headless: boolean }): Promise<Browser>;
}

export interface LoginProbe {
  /** Page to open when checking whether the session is still valid. */
  url: string;
  /**
   * Decide from the loaded page whether we are logged in. Returning false marks
   * the account `needs_reauth`.
   */
  isLoggedIn: (page: Page) => Promise<boolean>;
}

const STATE_PREFIX = 'browser-state';

export class BrowserSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;

  private readonly account: string;
  private readonly credentials: CredentialStore;
  private readonly headless: boolean;
  private readonly launcher: BrowserLauncher | undefined;
  private readonly timeoutMs: number;
  private readonly userAgent: string | undefined;

  constructor(opts: BrowserSessionOptions) {
    this.account = opts.account;
    this.credentials = opts.credentials ?? new CredentialStore();
    this.headless = opts.headless ?? true;
    this.launcher = opts.launcher;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.userAgent = opts.userAgent;
  }

  get stateKey(): string {
    return `${STATE_PREFIX}:${this.account}`;
  }

  /** Has a session ever been saved for this account? */
  async hasSavedState(): Promise<boolean> {
    return (await this.credentials.get(this.stateKey)) !== null;
  }

  /**
   * Open a context, restoring saved cookies when there are any.
   *
   * Corrupt saved state is discarded rather than thrown: a bad blob should send
   * the user to re-login, not wedge the daemon on every tick.
   */
  async open(): Promise<BrowserContext> {
    if (this.context) return this.context;

    const launcher = this.launcher ?? (await loadChromium());
    this.browser = await launcher.launch({ headless: this.headless });

    const saved = await this.credentials.get(this.stateKey);
    let storageState: any;
    if (saved) {
      try {
        storageState = JSON.parse(saved);
      } catch {
        await this.credentials.remove(this.stateKey);
      }
    }

    this.context = await this.browser.newContext({
      ...(storageState ? { storageState } : {}),
      ...(this.userAgent ? { userAgent: this.userAgent } : {}),
    });
    this.context.setDefaultTimeout(this.timeoutMs);
    return this.context;
  }

  /** Persist the current cookies through the credential store. */
  async save(): Promise<void> {
    if (!this.context) throw new ProviderError('no open browser context to save', 'misconfigured', false);
    const state = await this.context.storageState();
    await this.credentials.set(this.stateKey, JSON.stringify(state));
  }

  /**
   * Check whether the saved session still authenticates.
   *
   * Returns `{ ok: false }` rather than throwing so the caller can mark the
   * account `needs_reauth` and carry on with other platforms.
   */
  async check(probe: LoginProbe): Promise<{ ok: boolean; reason?: string }> {
    if (!(await this.hasSavedState())) {
      return { ok: false, reason: 'no saved session — run the interactive login once' };
    }

    let page: Page | undefined;
    try {
      const context = await this.open();
      page = await context.newPage();
      await page.goto(probe.url, { waitUntil: 'domcontentloaded' });
      const ok = await probe.isLoggedIn(page);
      return ok ? { ok: true } : { ok: false, reason: 'session expired — log in again' };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    } finally {
      await page?.close().catch(() => {});
    }
  }

  /**
   * Interactive first login: opens a visible window and waits for the probe to
   * report success, then saves the session.
   */
  async login(probe: LoginProbe, waitMs = 300_000): Promise<void> {
    if (this.headless) {
      throw new ProviderError(
        'interactive login needs a visible browser — construct the session with headless: false',
        'misconfigured',
        false,
      );
    }

    const context = await this.open();
    const page = await context.newPage();
    await page.goto(probe.url, { waitUntil: 'domcontentloaded' });

    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (await probe.isLoggedIn(page).catch(() => false)) {
        await this.save();
        await page.close().catch(() => {});
        return;
      }
      await page.waitForTimeout(2000);
    }

    await page.close().catch(() => {});
    throw new ProviderError('login was not completed in time', 'auth_expired', false);
  }

  /** Forget the saved session, forcing a fresh login. */
  async clear(): Promise<void> {
    await this.credentials.remove(this.stateKey);
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.context = null;
    this.browser = null;
  }
}

/**
 * Load Playwright lazily.
 *
 * Keeping the import out of module scope means the whole test suite and every
 * CLI-only workflow runs without Playwright's browsers being present.
 */
async function loadChromium(): Promise<BrowserLauncher> {
  try {
    const { chromium } = await import('playwright');
    return chromium;
  } catch (err) {
    throw new ProviderError(
      'playwright is not installed — run `pnpm add playwright && npx playwright install chromium`',
      'misconfigured',
      false,
      err,
    );
  }
}
