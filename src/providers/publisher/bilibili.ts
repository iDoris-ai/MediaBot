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
 * Bilibili text dynamics ("动态"), via the `bili` CLI.
 *
 * Scope is deliberately narrow: `bili dynamic-post` publishes text only. Video
 * submission is a different, much heavier flow with no CLI behind it, so this
 * provider declares no video support rather than pretending and failing at
 * publish time — the conformance suite checks that declared limits match real
 * behaviour precisely to stop that kind of drift.
 */

export const BILIBILI_LIMITS: PlatformLimits = {
  maxTextLength: 1000,
  supportsScheduling: false,
};

export interface BilibiliPublisherOptions {
  bin?: string;
  runner?: CliRunner;
  timeoutMs?: number;
}

export class BilibiliPublisher implements PublisherProvider {
  readonly info: ProviderInfo = {
    id: 'bilibili',
    slot: 'publisher',
    name: 'Bilibili dynamics (bili CLI)',
    upstream: 'bili-cli',
  };
  readonly platform = 'bilibili';
  readonly transport: PublishTransport = 'cli';
  readonly limits = BILIBILI_LIMITS;
  /** A dynamic is public the moment it lands. */
  readonly consequence: Consequence = 'irreversible';

  private readonly bin: string;
  private readonly runner: CliRunner;
  private readonly timeoutMs: number;

  constructor(opts: BilibiliPublisherOptions = {}) {
    this.bin = opts.bin ?? process.env.BILI_BIN ?? 'bili';
    this.runner = opts.runner ?? defaultCliRunner;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  async checkAuth(): Promise<AuthState> {
    try {
      const res = await runJsonCli<any>(this.runner, this.bin, ['status', '--json'], {
        timeoutMs: 30_000,
      });
      return res?.data?.authenticated === true
        ? { ok: true }
        : { ok: false, reason: 'not logged in — run `bili login`' };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : 'bili status failed' };
    }
  }

  async validate(variant: DraftVariant): Promise<ValidationResult> {
    const errors: ValidationIssue[] = [];
    const warnings: ValidationIssue[] = [];

    if (variant.body.trim().length === 0) {
      errors.push({ code: 'empty_body', field: 'body', message: 'a dynamic needs text' });
    } else if (variant.body.length > this.limits.maxTextLength) {
      errors.push({
        code: 'text_too_long',
        field: 'body',
        message: `body is ${variant.body.length} chars, limit is ${this.limits.maxTextLength}`,
      });
    }

    if (variant.media.length > 0) {
      warnings.push({
        code: 'media_ignored',
        field: 'media',
        message: 'bili dynamic-post publishes text only; attachments are dropped',
      });
    }
    if (variant.title) {
      warnings.push({
        code: 'title_ignored',
        field: 'title',
        message: 'dynamics have no title; it is prepended to the body instead',
      });
    }

    return { ok: errors.length === 0, errors, warnings };
  }

  async publish(variant: DraftVariant, options: PublishOptions): Promise<PublishResult> {
    if (options.dryRun) {
      return { platformPostId: `dryrun_${variant.id}`, publishedAt: new Date() };
    }

    // A dynamic has no title field, so a supplied title becomes the first line
    // rather than being silently discarded.
    const text = variant.title ? `${variant.title}\n\n${variant.body}` : variant.body;

    const res = await runJsonCli<any>(this.runner, this.bin, ['dynamic-post', text, '--json'], {
      timeoutMs: this.timeoutMs,
    });

    const id = res?.data?.dynamic_id ?? res?.data?.id;
    if (res?.ok === false || !id) {
      throw new ProviderError('bili dynamic-post returned no dynamic id', 'unknown', false);
    }

    return {
      platformPostId: String(id),
      url: `https://t.bilibili.com/${id}`,
      publishedAt: new Date(),
    };
  }
}
