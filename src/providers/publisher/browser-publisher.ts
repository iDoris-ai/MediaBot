import fs from 'fs';
import path from 'path';
import type { Page } from 'playwright';
import type {
  AuthState,
  Consequence,
  DraftVariant,
  PlatformLimits,
  ProviderInfo,
  PublishOptions,
  PublishResult,
  PublisherProvider,
  PublishTransport,
  ValidationIssue,
  ValidationResult,
} from '../../contracts';
import { ProviderError } from '../../contracts';
import { BrowserSession, type BrowserLauncher } from '../../core/browser';
import { CredentialStore } from '../../core/credentials';

/**
 * Publishes by driving the platform's own web UI.
 *
 * For Douyin, WeChat Channels and Kuaishou there is no API and no CLI, so this
 * is the only route. Two consequences shape the design:
 *
 * 1. **Selectors live in config, not source.** Creator-studio DOM changes
 *    without notice; a selector baked into a release means a broken publisher
 *    until the next release. Profiles are data the user can fix in minutes.
 *
 * 2. **An unverified profile refuses to publish.** Selectors that were never
 *    checked against the live page do not fail cleanly — they click the wrong
 *    thing, or half-fill a form and leave a broken draft. Refusing loudly is
 *    strictly better than attempting blindly, so `verified` must be set by
 *    someone who watched it work.
 */

export interface UploadSelectors {
  /** `input[type=file]` that accepts the video or images. */
  fileInput: string;
  titleInput?: string;
  /** Main body/description field. */
  bodyInput: string;
  /** Final submit control. */
  publishButton: string;
  /**
   * Proof the publish landed. Either a CSS selector, or `url:<glob>` when the
   * platform confirms by navigating instead of rendering a badge — both
   * XiaoHongShu and Channels do the latter.
   */
  successIndicator: string;
  /** Optional: an element that proves we ARE logged in. */
  loggedInIndicator?: string;
  /**
   * Optional: an element that proves we are NOT logged in.
   *
   * Creator studios usually signal the negative — a login box or a "scan to
   * log in" prompt appears — rather than marking the positive case, so this is
   * the more reliable check in practice.
   */
  loggedOutIndicator?: string;
}

export interface UploadProfile {
  platform: string;
  /** Creator upload page. */
  uploadUrl: string;
  /** Page used to test whether the session still authenticates. */
  loginUrl: string;
  selectors: UploadSelectors;
  limits: PlatformLimits;
  /**
   * Set to true only after watching these selectors drive a real publish.
   * Publishing is refused while false — see the class comment.
   */
  verified: boolean;
  /** Where the profile came from, for the error message. */
  source?: string;
}

export interface BrowserPublisherOptions {
  profile: UploadProfile;
  account?: string;
  credentials?: CredentialStore;
  launcher?: BrowserLauncher;
  headless?: boolean;
  session?: BrowserSession;
  timeoutMs?: number;
}

export class BrowserPublisher implements PublisherProvider {
  readonly info: ProviderInfo;
  readonly platform: string;
  readonly transport: PublishTransport = 'browser';
  readonly limits: PlatformLimits;
  /** Driving a creator console publishes for real; nothing here is undoable. */
  readonly consequence: Consequence = 'irreversible';

  private readonly profile: UploadProfile;
  private readonly session: BrowserSession;
  private readonly timeoutMs: number;

  constructor(opts: BrowserPublisherOptions) {
    this.profile = opts.profile;
    this.platform = opts.profile.platform;
    this.limits = opts.profile.limits;
    this.info = {
      id: `browser:${this.platform}`,
      slot: 'publisher',
      name: `${this.platform} (browser)`,
    };
    this.timeoutMs = opts.timeoutMs ?? 180_000;

    this.session =
      opts.session ??
      new BrowserSession({
        account: `${this.platform}:${opts.account ?? 'default'}`,
        ...(opts.credentials ? { credentials: opts.credentials } : {}),
        ...(opts.launcher ? { launcher: opts.launcher } : {}),
        headless: opts.headless ?? true,
      });
  }

  get isVerified(): boolean {
    return this.profile.verified;
  }

  async checkAuth(): Promise<AuthState> {
    const res = await this.session.check({
      url: this.profile.loginUrl,
      isLoggedIn: async (page: Page) => {
        const { loggedOutIndicator, loggedInIndicator } = this.profile.selectors;
        // The negative marker wins when both are present: seeing the login box
        // is conclusive, whereas a positive marker can render before auth
        // resolves.
        if (loggedOutIndicator) {
          return (await page.locator(loggedOutIndicator).count()) === 0;
        }
        if (loggedInIndicator) {
          return (await page.locator(loggedInIndicator).count()) > 0;
        }
        return !/login|passport|signin/i.test(page.url());
      },
    });
    return res.ok ? { ok: true } : { ok: false, reason: res.reason ?? 'not logged in' };
  }

  async validate(variant: DraftVariant): Promise<ValidationResult> {
    const errors: ValidationIssue[] = [];
    const warnings: ValidationIssue[] = [];

    if (!this.profile.verified) {
      warnings.push({
        code: 'profile_unverified',
        message:
          `the "${this.platform}" selector profile has not been verified against the live page; ` +
          `publishing will be refused until it is`,
      });
    }

    if (variant.body.length > this.limits.maxTextLength) {
      errors.push({
        code: 'text_too_long',
        field: 'body',
        message: `body is ${variant.body.length} chars, limit is ${this.limits.maxTextLength}`,
      });
    }
    if (
      variant.title &&
      this.limits.maxTitleLength &&
      variant.title.length > this.limits.maxTitleLength
    ) {
      errors.push({
        code: 'title_too_long',
        field: 'title',
        message: `title is ${variant.title.length} chars, limit is ${this.limits.maxTitleLength}`,
      });
    }

    if (variant.media.length === 0) {
      errors.push({
        code: 'media_required',
        field: 'media',
        message: 'the upload flow starts from a file; there is nothing to upload',
      });
    }

    for (const [i, m] of variant.media.entries()) {
      if (!path.isAbsolute(m.path)) {
        errors.push({
          code: 'media_path_not_absolute',
          field: `media[${i}]`,
          message: `path must be absolute: ${m.path}`,
        });
        continue;
      }
      if (!fs.existsSync(m.path)) {
        errors.push({ code: 'media_missing', field: `media[${i}]`, message: `not found: ${m.path}` });
        continue;
      }
      if (m.kind === 'video' && this.limits.video) {
        const { maxSeconds, maxBytes, formats } = this.limits.video;
        const bytes = m.bytes ?? fs.statSync(m.path).size;
        if (bytes > maxBytes) {
          errors.push({
            code: 'video_too_large',
            field: `media[${i}]`,
            message: `${bytes} bytes exceeds ${maxBytes}`,
          });
        }
        if (m.durationSeconds !== undefined && m.durationSeconds > maxSeconds) {
          errors.push({
            code: 'video_too_long',
            field: `media[${i}]`,
            message: `${m.durationSeconds}s exceeds ${maxSeconds}s`,
          });
        }
        const ext = path.extname(m.path).replace('.', '').toLowerCase();
        if (ext && !formats.includes(ext)) {
          errors.push({
            code: 'unsupported_video_format',
            field: `media[${i}]`,
            message: `.${ext} not in ${formats.join(', ')}`,
          });
        }
      }
    }

    return { ok: errors.length === 0, errors, warnings };
  }

  async publish(variant: DraftVariant, options: PublishOptions): Promise<PublishResult> {
    if (options.dryRun) {
      return { platformPostId: `dryrun_${variant.id}`, publishedAt: new Date() };
    }

    if (!this.profile.verified) {
      throw new ProviderError(
        `refusing to publish to ${this.platform}: its selector profile is unverified. ` +
          `Open ${this.profile.uploadUrl}, confirm each selector in ${this.profile.source ?? 'the profile config'} ` +
          `matches the live page, then set "verified": true. ` +
          `Unverified selectors do not fail cleanly — they click the wrong control or leave a half-filled draft.`,
        'misconfigured',
        false,
      );
    }

    const context = await this.session.open();
    const page = await context.newPage();

    try {
      await page.goto(this.profile.uploadUrl, { waitUntil: 'domcontentloaded' });

      const s = this.profile.selectors;
      await page.setInputFiles(s.fileInput, variant.media.map((m) => m.path));

      if (variant.title && s.titleInput) {
        await page.fill(s.titleInput, variant.title);
      }
      await page.fill(s.bodyInput, variant.body);

      await page.click(s.publishButton);
      // Success must be observed, not assumed: the click can be swallowed by a
      // validation toast, leaving an unpublished draft that we would otherwise
      // record as published.
      await this.waitForSuccess(page, s.successIndicator);

      // The web UI rarely exposes a post id; the page URL is the best anchor.
      return {
        platformPostId: `${this.platform}:${Date.now()}`,
        url: page.url(),
        publishedAt: new Date(),
      };
    } catch (err) {
      throw new ProviderError(
        `${this.platform} upload failed: ${err instanceof Error ? err.message : String(err)}`,
        'unknown',
        false,
        err,
      );
    } finally {
      await page.close().catch(() => {});
    }
  }

  /** Wait for either a URL navigation or an element, per the indicator form. */
  private async waitForSuccess(page: Page, indicator: string): Promise<void> {
    if (indicator.startsWith('url:')) {
      await page.waitForURL(indicator.slice('url:'.length), { timeout: this.timeoutMs });
      return;
    }
    await page.waitForSelector(indicator, { timeout: this.timeoutMs });
  }

  async close(): Promise<void> {
    await this.session.close();
  }
}

/**
 * Starting-point profiles.
 *
 * XiaoHongShu-video and Channels carry selectors observed from working
 * third-party automations; Douyin and Kuaishou are still placeholders. Either
 * way every profile ships `verified: false`, because "looks right" is not
 * "watched it work" — and a rule that bends for selectors that merely look
 * plausible is not a rule. Confirm against the live studio, then flip the flag.
 */
export const UPLOAD_PROFILE_TEMPLATES: Record<string, UploadProfile> = {
  'xiaohongshu-video': {
    platform: 'xiaohongshu-video',
    uploadUrl: 'https://creator.xiaohongshu.com/publish/publish?from=homepage&target=video',
    loginUrl: 'https://creator.xiaohongshu.com',
    selectors: {
      fileInput: 'input[type="file"]',
      titleInput: 'input[placeholder*="填写标题"]',
      bodyInput: 'p[data-placeholder*="输入正文描述"]',
      publishButton: 'button:has-text("发布")',
      // XHS confirms by navigating, not by rendering a badge.
      successIndicator: 'url:**/publish/success?**',
      loggedOutIndicator: "div[class*='login-box']",
    },
    limits: {
      maxTextLength: 1000,
      maxTitleLength: 20,
      video: { maxSeconds: 900, maxBytes: 5 * 1024 * 1024 * 1024, formats: ['mp4', 'mov'] },
      supportsScheduling: false,
    },
    verified: false,
    source: '~/.mediabot/config.json → browserProfiles.xiaohongshu-video',
  },
  'wechat-channels': {
    platform: 'wechat-channels',
    uploadUrl: 'https://channels.weixin.qq.com/platform/post/create',
    loginUrl: 'https://channels.weixin.qq.com/platform',
    selectors: {
      fileInput: 'input[type="file"]',
      bodyInput: 'div.input-editor',
      publishButton: 'div.form-btns button:has-text("发表")',
      successIndicator: 'url:**/post/list**',
      // Channels shows a WeChat-Store banner or a scan prompt when signed out.
      loggedOutIndicator: 'div.title-name:has-text("微信小店")',
    },
    limits: {
      maxTextLength: 1000,
      maxTitleLength: 22,
      video: { maxSeconds: 1800, maxBytes: 20 * 1024 * 1024 * 1024, formats: ['mp4'] },
      supportsScheduling: false,
    },
    verified: false,
    source: '~/.mediabot/config.json → browserProfiles.wechat-channels',
  },
  douyin: {
    platform: 'douyin',
    uploadUrl: 'https://creator.douyin.com/creator-micro/content/upload',
    loginUrl: 'https://creator.douyin.com/',
    // Placeholders: no observed values for this platform yet.
    selectors: {
      fileInput: 'input[type="file"]',
      titleInput: '',
      bodyInput: '',
      publishButton: '',
      successIndicator: '',
    },
    limits: {
      maxTextLength: 1000,
      maxTitleLength: 30,
      video: { maxSeconds: 900, maxBytes: 4 * 1024 * 1024 * 1024, formats: ['mp4', 'mov'] },
      supportsScheduling: false,
    },
    verified: false,
    source: '~/.mediabot/config.json → browserProfiles.douyin',
  },
  kuaishou: {
    platform: 'kuaishou',
    uploadUrl: 'https://cp.kuaishou.com/article/publish/video',
    loginUrl: 'https://cp.kuaishou.com/',
    // Placeholders: no observed values for this platform yet.
    selectors: {
      fileInput: 'input[type="file"]',
      titleInput: '',
      bodyInput: '',
      publishButton: '',
      successIndicator: '',
    },
    limits: {
      maxTextLength: 500,
      video: { maxSeconds: 600, maxBytes: 4 * 1024 * 1024 * 1024, formats: ['mp4', 'mov'] },
      supportsScheduling: false,
    },
    verified: false,
    source: '~/.mediabot/config.json → browserProfiles.kuaishou',
  },
};

/** Which selectors a profile still needs before it can be verified. */
export function missingSelectors(profile: UploadProfile): string[] {
  const required: Array<keyof UploadSelectors> = [
    'fileInput',
    'bodyInput',
    'publishButton',
    'successIndicator',
  ];
  return required.filter((k) => !profile.selectors[k]);
}
