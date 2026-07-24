import fs from 'fs';
import path from 'path';
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
import { defaultCliRunner, runJsonCli, type CliRunner } from '../../core/cli-adapter';

/**
 * Twitter/X publisher, driven through the `twitter` CLI.
 *
 * Same integration mode as the XHS provider: shell out to a tool the user has
 * already logged in, rather than reimplementing auth. This is what gives
 * MediaBot English-language reach without an X API subscription.
 */

export const TWITTER_LIMITS: PlatformLimits = {
  // The free tier's post limit. Long-form posts need a paid tier, so treating
  // 280 as the ceiling keeps validation honest for the common case.
  maxTextLength: 280,
  maxImages: 4,
  supportsScheduling: false,
};

export interface TwitterPublisherOptions {
  bin?: string;
  runner?: CliRunner;
  timeoutMs?: number;
}

interface TwitterPostResponse {
  ok?: boolean;
  data?: { id?: string; tweet_id?: string; url?: string; screenName?: string };
  error?: string;
}

export class TwitterPublisher implements PublisherProvider {
  readonly info: ProviderInfo = {
    id: 'twitter',
    slot: 'publisher',
    name: 'Twitter/X (twitter CLI)',
    upstream: 'twitter-cli',
  };
  readonly platform = 'twitter';
  readonly transport: PublishTransport = 'cli';
  readonly limits = TWITTER_LIMITS;
  /** Deleting a tweet does not unsend it — it has already been seen. */
  readonly consequence: Consequence = 'irreversible';

  private readonly bin: string;
  private readonly runner: CliRunner;
  private readonly timeoutMs: number;

  constructor(opts: TwitterPublisherOptions = {}) {
    this.bin = opts.bin ?? process.env.TWITTER_BIN ?? 'twitter';
    this.runner = opts.runner ?? defaultCliRunner;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  async checkAuth(): Promise<AuthState> {
    try {
      const res = await runJsonCli<any>(this.runner, this.bin, ['status', '--json'], {
        timeoutMs: 30_000,
      });
      return res?.data?.authenticated === true
        ? { ok: true }
        : { ok: false, reason: 'not logged in — run `twitter login`' };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : 'twitter status failed' };
    }
  }

  async validate(variant: DraftVariant): Promise<ValidationResult> {
    const errors: ValidationIssue[] = [];
    const warnings: ValidationIssue[] = [];

    // X counts characters, not bytes, and CJK counts double. Use the stricter
    // weighted length so a Chinese post is not silently rejected by the API.
    const weighted = weightedLength(variant.body);
    if (weighted > this.limits.maxTextLength) {
      errors.push({
        code: 'text_too_long',
        field: 'body',
        message: `body weighs ${weighted} of ${this.limits.maxTextLength} (CJK characters count double on X)`,
      });
    }
    if (variant.body.trim().length === 0) {
      errors.push({ code: 'empty_body', field: 'body', message: 'a tweet needs text' });
    }

    const images = variant.media.filter((m) => m.kind === 'image');
    if (images.length > this.limits.maxImages!) {
      errors.push({
        code: 'too_many_images',
        field: 'media',
        message: `${images.length} images, X allows ${this.limits.maxImages}`,
      });
    }
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

    if (variant.media.some((m) => m.kind === 'video')) {
      warnings.push({
        code: 'video_ignored',
        field: 'media',
        message: 'this provider attaches images only; video is ignored',
      });
    }
    if (variant.title) {
      warnings.push({
        code: 'title_ignored',
        field: 'title',
        message: 'X has no title field; only body is posted',
      });
    }

    return { ok: errors.length === 0, errors, warnings };
  }

  async publish(variant: DraftVariant, options: PublishOptions): Promise<PublishResult> {
    if (options.dryRun) {
      return { platformPostId: `dryrun_${variant.id}`, publishedAt: new Date() };
    }

    const images = variant.media.filter((m) => m.kind === 'image').map((m) => m.path);
    const args = [
      'post',
      variant.body,
      ...images.flatMap((p) => ['--image', p]),
      '--json',
    ];

    const res = await runJsonCli<TwitterPostResponse>(this.runner, this.bin, args, {
      timeoutMs: this.timeoutMs,
    });

    const id = res?.data?.tweet_id ?? res?.data?.id;
    if (res?.ok === false || !id) {
      throw new ProviderError(
        `twitter post did not return a tweet id${res?.error ? `: ${res.error}` : ''}`,
        'unknown',
        false,
      );
    }

    const handle = res.data?.screenName;
    return {
      platformPostId: String(id),
      url: res.data?.url ?? `https://x.com/${handle ?? 'i'}/status/${id}`,
      publishedAt: new Date(),
    };
  }
}

/**
 * X's weighted character count: CJK and most non-Latin ranges cost two.
 *
 * Validating on raw `.length` would let a 200-character Chinese post through
 * that the platform then rejects at publish time — a failure the approval
 * queue cannot undo, since the human already said yes.
 */
export function weightedLength(text: string): number {
  let total = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const isWide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd);
    total += isWide ? 2 : 1;
  }
  return total;
}
