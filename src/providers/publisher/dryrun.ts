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
import { payloadHash } from '../../core/identity';

/**
 * Publisher that writes to disk instead of the internet.
 *
 * This is what lets the whole pipeline be verified end-to-end in CI with no
 * platform credentials: swap it for a real publisher and nothing else changes.
 * It also doubles as the reference implementation of the publisher contract.
 */

export interface DryRunOptions {
  platform?: string;
  outDir?: string;
  limits?: Partial<PlatformLimits>;
  transport?: PublishTransport;
  id?: string;
}

const DEFAULT_LIMITS: PlatformLimits = {
  maxTextLength: 2000,
  maxTitleLength: 100,
  maxImages: 9,
  video: { maxSeconds: 300, maxBytes: 500 * 1024 * 1024, formats: ['mp4', 'mov'] },
  supportsScheduling: false,
};

export class DryRunPublisher implements PublisherProvider {
  readonly info: ProviderInfo;
  readonly platform: string;
  readonly transport: PublishTransport;
  readonly limits: PlatformLimits;

  private readonly outDir: string;

  constructor(opts: DryRunOptions = {}) {
    this.platform = opts.platform ?? 'dryrun';
    this.info = {
      id: opts.id ?? `dryrun:${this.platform}`,
      slot: 'publisher',
      name: `Dry-run (${this.platform})`,
    };
    this.transport = opts.transport ?? 'api';
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    this.outDir = opts.outDir ?? path.join(process.cwd(), 'out');
  }

  async checkAuth(): Promise<AuthState> {
    return { ok: true };
  }

  async validate(variant: DraftVariant): Promise<ValidationResult> {
    const errors: ValidationIssue[] = [];
    const warnings: ValidationIssue[] = [];

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

    const images = variant.media.filter((m) => m.kind === 'image');
    if (this.limits.maxImages && images.length > this.limits.maxImages) {
      errors.push({
        code: 'too_many_images',
        field: 'media',
        message: `${images.length} images, limit is ${this.limits.maxImages}`,
      });
    }

    for (const [i, m] of variant.media.entries()) {
      if (m.kind !== 'video' || !this.limits.video) continue;
      const { maxSeconds, maxBytes, formats } = this.limits.video;
      if (m.durationSeconds !== undefined && m.durationSeconds > maxSeconds) {
        errors.push({
          code: 'video_too_long',
          field: `media[${i}]`,
          message: `${m.durationSeconds}s exceeds ${maxSeconds}s`,
        });
      }
      if (m.bytes !== undefined && m.bytes > maxBytes) {
        errors.push({
          code: 'video_too_large',
          field: `media[${i}]`,
          message: `${m.bytes} bytes exceeds ${maxBytes}`,
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

    if (variant.body.trim().length === 0 && variant.media.length === 0) {
      warnings.push({ code: 'empty_post', message: 'no text and no media' });
    }

    return { ok: errors.length === 0, errors, warnings };
  }

  async publish(variant: DraftVariant, options: PublishOptions): Promise<PublishResult> {
    const publishedAt = new Date();
    // Deterministic id from content + account, so a replayed publish produces
    // the same "platform post id" rather than a fresh random one.
    const platformPostId = `dryrun_${payloadHash({
      variantId: variant.id,
      accountId: options.accountId,
    }).slice(0, 16)}`;

    const dir = path.join(this.outDir, this.platform);
    fs.mkdirSync(dir, { recursive: true });

    const record = {
      platformPostId,
      platform: this.platform,
      accountId: options.accountId,
      dryRun: options.dryRun ?? false,
      scheduledFor: options.scheduledFor?.toISOString() ?? null,
      publishedAt: publishedAt.toISOString(),
      variant,
    };
    fs.writeFileSync(path.join(dir, `${platformPostId}.json`), JSON.stringify(record, null, 2));

    const md = [
      variant.title ? `# ${variant.title}` : null,
      variant.body,
      variant.media.length ? `\n---\n${variant.media.map((m) => `- ${m.kind}: ${m.path}`).join('\n')}` : null,
    ]
      .filter(Boolean)
      .join('\n\n');
    fs.writeFileSync(path.join(dir, `${platformPostId}.md`), `${md}\n`);

    return { platformPostId, url: `file://${path.join(dir, `${platformPostId}.md`)}`, publishedAt };
  }
}
