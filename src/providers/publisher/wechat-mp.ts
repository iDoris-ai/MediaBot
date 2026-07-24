import fs from 'fs';
import path from 'path';
import type {
  AuthState,
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

/**
 * WeChat Official Account publisher, via the official draft API.
 *
 * Deliberately stops at the draft box rather than calling freepublish/submit:
 * an Official Account gets a small, non-renewable number of mass sends per day,
 * so an automated publish is both irreversible and quota-consuming. MediaBot
 * creates the draft and a human presses send in the WeChat console — the same
 * split the approval gate uses everywhere else, applied one notch earlier
 * because the platform's own cost model demands it.
 *
 * Approach ported from jhfnetboy/wechat-content-pipeline (MIT).
 */

const BASE_URL = 'https://api.weixin.qq.com';

export const WECHAT_MP_LIMITS: PlatformLimits = {
  // Article bodies can be very long; this is a sanity bound, not a platform cap.
  maxTextLength: 20_000,
  maxTitleLength: 64,
  maxImages: 20,
  supportsScheduling: false,
};

export interface WeChatMpOptions {
  appId?: string;
  appSecret?: string;
  author?: string;
  fetchImpl?: typeof fetch;
  /** Access tokens last ~2h; refresh a little early to avoid edge expiry. */
  tokenTtlMs?: number;
  now?: () => number;
}

interface WxError {
  errcode?: number;
  errmsg?: string;
}

export class WeChatMpPublisher implements PublisherProvider {
  readonly info: ProviderInfo = {
    id: 'wechat-mp',
    slot: 'publisher',
    name: 'WeChat Official Account (draft API)',
    upstream: 'jhfnetboy/wechat-content-pipeline (MIT)',
  };
  readonly platform = 'wechat-mp';
  readonly transport: PublishTransport = 'api';
  readonly limits = WECHAT_MP_LIMITS;

  private readonly appId: string | undefined;
  private readonly appSecret: string | undefined;
  private readonly author: string;
  private readonly fetchImpl: typeof fetch;
  private readonly tokenTtlMs: number;
  private readonly now: () => number;

  private token: { value: string; expiresAt: number } | null = null;

  constructor(opts: WeChatMpOptions = {}) {
    this.appId = opts.appId ?? process.env.WECHAT_APP_ID;
    this.appSecret = opts.appSecret ?? process.env.WECHAT_APP_SECRET;
    this.author = opts.author ?? process.env.WECHAT_DEFAULT_AUTHOR ?? '';
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.tokenTtlMs = opts.tokenTtlMs ?? 90 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  async checkAuth(): Promise<AuthState> {
    if (!this.appId || !this.appSecret) {
      return { ok: false, reason: 'set WECHAT_APP_ID and WECHAT_APP_SECRET' };
    }
    try {
      await this.accessToken();
      return { ok: true, expiresAt: new Date(this.token!.expiresAt) };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : 'token request failed' };
    }
  }

  async validate(variant: DraftVariant): Promise<ValidationResult> {
    const errors: ValidationIssue[] = [];
    const warnings: ValidationIssue[] = [];

    if (!variant.title || variant.title.trim().length === 0) {
      errors.push({ code: 'title_required', field: 'title', message: 'an article needs a title' });
    } else if (variant.title.length > this.limits.maxTitleLength!) {
      errors.push({
        code: 'title_too_long',
        field: 'title',
        message: `title is ${variant.title.length} chars, limit is ${this.limits.maxTitleLength}`,
      });
    }

    if (variant.body.trim().length === 0) {
      errors.push({ code: 'empty_body', field: 'body', message: 'article body is empty' });
    } else if (variant.body.length > this.limits.maxTextLength) {
      errors.push({
        code: 'text_too_long',
        field: 'body',
        message: `body is ${variant.body.length} chars, limit is ${this.limits.maxTextLength}`,
      });
    }

    const images = variant.media.filter((m) => m.kind === 'image');
    for (const [i, img] of images.entries()) {
      if (!path.isAbsolute(img.path)) {
        errors.push({
          code: 'image_path_not_absolute',
          field: `media[${i}]`,
          message: `image path must be absolute: ${img.path}`,
        });
      } else if (!fs.existsSync(img.path)) {
        errors.push({ code: 'image_missing', field: `media[${i}]`, message: `not found: ${img.path}` });
      }
    }

    if (images.length === 0) {
      // Without a cover the article still drafts, but renders poorly in feeds.
      warnings.push({
        code: 'no_cover',
        field: 'media',
        message: 'no image supplied; the article will have no cover',
      });
    }

    return { ok: errors.length === 0, errors, warnings };
  }

  /**
   * Creates a draft. Never mass-sends — see the class comment.
   *
   * The returned `platformPostId` is the draft's media_id.
   */
  async publish(variant: DraftVariant, options: PublishOptions): Promise<PublishResult> {
    if (options.dryRun) {
      return { platformPostId: `dryrun_${variant.id}`, publishedAt: new Date() };
    }

    const token = await this.accessToken();
    const cover = variant.media.find((m) => m.kind === 'image');
    const thumbMediaId = cover ? await this.uploadImage(token, cover.path) : '';

    const article = {
      title: variant.title ?? '未命名文章',
      author: (variant.meta as any)?.author ?? this.author,
      content: variant.body,
      thumb_media_id: thumbMediaId,
      digest: (variant.meta as any)?.digest ?? '',
      content_source_url: (variant.meta as any)?.sourceUrl ?? '',
      need_open_comment: (variant.meta as any)?.openComment ? 1 : 0,
      only_fans_can_comment: 0,
    };

    const data = await this.post<{ media_id?: string }>(
      `/cgi-bin/draft/add?access_token=${token}`,
      { articles: [article] },
    );

    if (!data.media_id) {
      throw new ProviderError('draft/add returned no media_id', 'unknown', false);
    }

    return {
      platformPostId: data.media_id,
      url: 'https://mp.weixin.qq.com/cgi-bin/appmsg',
      publishedAt: new Date(),
    };
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now()) return this.token.value;
    if (!this.appId || !this.appSecret) {
      throw new ProviderError(
        'WECHAT_APP_ID / WECHAT_APP_SECRET are not configured',
        'misconfigured',
        false,
      );
    }

    const url =
      `${BASE_URL}/cgi-bin/token?grant_type=client_credential` +
      `&appid=${encodeURIComponent(this.appId)}&secret=${encodeURIComponent(this.appSecret)}`;

    const res = await this.fetchImpl(url);
    const data = (await res.json()) as WxError & { access_token?: string };

    if (data.errcode || !data.access_token) {
      throw wxError('token request failed', data);
    }

    this.token = { value: data.access_token, expiresAt: this.now() + this.tokenTtlMs };
    return this.token.value;
  }

  private async uploadImage(token: string, filePath: string): Promise<string> {
    const bytes = fs.readFileSync(filePath);
    const form = new FormData();
    form.append(
      'media',
      new Blob([new Uint8Array(bytes)], { type: mimeOf(filePath) }),
      path.basename(filePath),
    );

    const res = await this.fetchImpl(
      `${BASE_URL}/cgi-bin/material/add_material?access_token=${token}&type=image`,
      { method: 'POST', body: form },
    );
    const data = (await res.json()) as WxError & { media_id?: string };

    if (data.errcode || !data.media_id) throw wxError('image upload failed', data);
    return data.media_id;
  }

  private async post<T>(pathname: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(`${BASE_URL}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as WxError & T;
    if (data.errcode) throw wxError(`request to ${pathname.split('?')[0]} failed`, data);
    return data;
  }
}

function mimeOf(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext || 'png'}`;
}

/**
 * Map WeChat error codes onto retry behaviour.
 *
 * 40001/42001 mean the token is stale — recoverable, so retryable. An IP that
 * is not whitelisted (61004) needs a human in the console, so it must not be
 * retried into a loop.
 */
function wxError(context: string, data: WxError): ProviderError {
  const code = data.errcode ?? 0;
  const message = `${context}: [${code}] ${data.errmsg ?? 'unknown'}`;

  if (code === 40001 || code === 42001 || code === 40014) {
    return new ProviderError(message, 'auth_expired', true);
  }
  if (code === 61004 || code === 40164) {
    return new ProviderError(`${message} — add this machine's IP to the MP allowlist`, 'misconfigured', false);
  }
  if (code === 45009 || code === 45011) {
    return new ProviderError(message, 'rate_limited', true);
  }
  if (code === 40125 || code === 41002) {
    return new ProviderError(message, 'misconfigured', false);
  }
  return new ProviderError(message, 'unknown', false);
}
