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
import { defaultCliRunner, runJsonCli, type CliRunner } from '../../core/cli-adapter';

/**
 * XiaoHongShu publisher, driven through the `xhs` CLI.
 *
 * XHS has no official publishing API, and the open-source projects that do it
 * ship without a licence — so rather than reimplementing the reverse-engineered
 * signing, MediaBot shells out to the `xhs` tool the user already has logged in.
 * Invoking a binary is not a derivative work, which keeps this licence-clean.
 *
 * Trade-off worth stating plainly: `xhs` rides a reverse-engineered API, so it
 * can break when the platform changes. The provider contract is what contains
 * that risk — swapping in another transport later touches only this file.
 */

export const XHS_LIMITS: PlatformLimits = {
  // Platform caps as enforced by the XHS composer UI.
  maxTextLength: 1000,
  maxTitleLength: 20,
  maxImages: 18,
  supportsScheduling: false,
};

export interface XhsPublisherOptions {
  bin?: string;
  runner?: CliRunner;
  timeoutMs?: number;
  /** Publish as a private note — useful for a first live smoke test. */
  privateByDefault?: boolean;
}

interface XhsPostResponse {
  ok?: boolean;
  data?: { note_id?: string; id?: string; url?: string };
  error?: string;
}

export class XiaohongshuPublisher implements PublisherProvider {
  readonly info: ProviderInfo = {
    id: 'xhs',
    slot: 'publisher',
    name: 'XiaoHongShu (xhs CLI)',
    upstream: 'xhs-cli',
  };
  readonly platform = 'xiaohongshu';
  readonly transport: PublishTransport = 'cli';
  readonly limits = XHS_LIMITS;

  private readonly bin: string;
  private readonly runner: CliRunner;
  private readonly timeoutMs: number;
  private readonly privateByDefault: boolean;

  constructor(opts: XhsPublisherOptions = {}) {
    this.bin = opts.bin ?? process.env.XHS_BIN ?? 'xhs';
    this.runner = opts.runner ?? defaultCliRunner;
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    this.privateByDefault = opts.privateByDefault ?? false;
  }

  async checkAuth(): Promise<AuthState> {
    try {
      const res = await runJsonCli<any>(this.runner, this.bin, ['status', '--json'], {
        timeoutMs: 30_000,
      });
      const authed = res?.data?.authenticated === true;
      return authed
        ? { ok: true }
        : { ok: false, reason: 'not logged in — run `xhs login`' };
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : 'xhs status failed',
      };
    }
  }

  async validate(variant: DraftVariant): Promise<ValidationResult> {
    const errors: ValidationIssue[] = [];
    const warnings: ValidationIssue[] = [];

    if (variant.body.length > this.limits.maxTextLength) {
      errors.push({
        code: 'text_too_long',
        field: 'body',
        message: `body is ${variant.body.length} chars, XHS allows ${this.limits.maxTextLength}`,
      });
    }
    if (!variant.title || variant.title.trim().length === 0) {
      errors.push({ code: 'title_required', field: 'title', message: 'XHS notes require a title' });
    } else if (variant.title.length > this.limits.maxTitleLength!) {
      errors.push({
        code: 'title_too_long',
        field: 'title',
        message: `title is ${variant.title.length} chars, XHS allows ${this.limits.maxTitleLength}`,
      });
    }

    const images = variant.media.filter((m) => m.kind === 'image');
    if (images.length === 0) {
      // `xhs post` requires --images; a text-only note cannot be published.
      errors.push({
        code: 'image_required',
        field: 'media',
        message: 'XHS image notes need at least one image',
      });
    } else if (images.length > this.limits.maxImages!) {
      errors.push({
        code: 'too_many_images',
        field: 'media',
        message: `${images.length} images, XHS allows ${this.limits.maxImages}`,
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
        errors.push({
          code: 'image_missing',
          field: `media[${i}]`,
          message: `image not found: ${img.path}`,
        });
      }
    }

    if (variant.media.some((m) => m.kind === 'video')) {
      warnings.push({
        code: 'video_ignored',
        field: 'media',
        message: 'this provider publishes image notes only; video attachments are ignored',
      });
    }

    return { ok: errors.length === 0, errors, warnings };
  }

  async publish(variant: DraftVariant, options: PublishOptions): Promise<PublishResult> {
    const images = variant.media.filter((m) => m.kind === 'image').map((m) => m.path);
    const topic = topicOf(variant);

    const args = [
      'post',
      '--title', variant.title ?? '',
      '--body', variant.body,
      ...images.flatMap((p) => ['--images', p]),
      ...(topic ? ['--topic', topic] : []),
      ...(this.privateByDefault ? ['--private'] : []),
      '--json',
    ];

    // A dry run stops here on purpose: publishing to XHS is irreversible from
    // MediaBot's side, so the flag must never reach the real post command.
    if (options.dryRun) {
      return {
        platformPostId: `dryrun_${variant.id}`,
        publishedAt: new Date(),
      };
    }

    const res = await runJsonCli<XhsPostResponse>(this.runner, this.bin, args, {
      timeoutMs: this.timeoutMs,
    });

    const noteId = res?.data?.note_id ?? res?.data?.id;
    if (res?.ok === false || !noteId) {
      throw new ProviderError(
        `xhs post did not return a note id${res?.error ? `: ${res.error}` : ''}`,
        'unknown',
        false,
      );
    }

    return {
      platformPostId: noteId,
      url: res.data?.url ?? `https://www.xiaohongshu.com/explore/${noteId}`,
      publishedAt: new Date(),
    };
  }
}

/** First hashtag from variant.meta.tags, which XHS attaches as a topic. */
function topicOf(variant: DraftVariant): string | undefined {
  const tags = (variant.meta as any)?.tags;
  if (!Array.isArray(tags) || tags.length === 0) return undefined;
  const first = tags[0];
  return typeof first === 'string' && first.trim() ? first.replace(/^#/, '').trim() : undefined;
}
