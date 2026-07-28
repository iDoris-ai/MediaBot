import fs from 'fs';
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
import { TelegramApi } from '../telegram/api';

/**
 * Scheduled messages to a Telegram group or channel.
 *
 * The chat is part of the account configuration rather than the draft, so a
 * misrouted `chat_id` in generated content cannot send a post to the wrong
 * group.
 */

export const TELEGRAM_LIMITS: PlatformLimits = {
  // Bot API caps a text message at 4096 characters.
  maxTextLength: 4096,
  maxImages: 1,
  supportsScheduling: false,
};

export interface TelegramPublisherOptions {
  token: string;
  /** Target group/channel, e.g. "-1001234567890" or "@mychannel". */
  chatId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class TelegramPublisher implements PublisherProvider {
  readonly info: ProviderInfo = {
    id: 'telegram',
    slot: 'publisher',
    name: 'Telegram group / channel',
    upstream: 'Telegram Bot API',
  };
  readonly platform = 'telegram';
  readonly transport: PublishTransport = 'api';
  readonly limits = TELEGRAM_LIMITS;
  /** A group message is read before it can be deleted. */
  readonly consequence: Consequence = 'irreversible';

  private readonly api: TelegramApi;
  private readonly chatId: string;

  constructor(opts: TelegramPublisherOptions) {
    this.api = new TelegramApi({
      token: opts.token,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
    this.chatId = opts.chatId;
  }

  async checkAuth(): Promise<AuthState> {
    if (!this.chatId) return { ok: false, reason: 'no chatId configured' };
    try {
      await this.api.getMe();
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : 'getMe failed' };
    }
  }

  async validate(variant: DraftVariant): Promise<ValidationResult> {
    const errors: ValidationIssue[] = [];
    const warnings: ValidationIssue[] = [];

    // A title has no separate field here; it is prepended, so it counts toward
    // the same 4096 budget.
    const composed = composeText(variant);
    if (!composed.trim()) {
      errors.push({ code: 'empty_body', field: 'body', message: 'a message needs text' });
    } else if (composed.length > this.limits.maxTextLength) {
      errors.push({
        code: 'text_too_long',
        field: 'body',
        message: `message is ${composed.length} chars including the title, limit is ${this.limits.maxTextLength}`,
      });
    }

    const images = variant.media.filter((m) => m.kind === 'image');
    if (images.length > this.limits.maxImages!) {
      warnings.push({
        code: 'extra_images_dropped',
        field: 'media',
        message: `only the first of ${images.length} images will be sent`,
      });
    }
    for (const [i, img] of images.slice(0, 1).entries()) {
      if (!fs.existsSync(img.path)) {
        errors.push({ code: 'image_missing', field: `media[${i}]`, message: `not found: ${img.path}` });
      }
    }
    if (variant.media.some((m) => m.kind === 'video')) {
      warnings.push({
        code: 'video_ignored',
        field: 'media',
        message: 'this provider sends text and a single photo; video is ignored',
      });
    }

    return { ok: errors.length === 0, errors, warnings };
  }

  async publish(variant: DraftVariant, options: PublishOptions): Promise<PublishResult> {
    const text = composeText(variant);

    if (options.dryRun) {
      return { platformPostId: `dryrun_${variant.id}`, publishedAt: new Date() };
    }

    const photo = variant.media.find((m) => m.kind === 'image');
    const sent = photo
      ? await this.api.sendPhoto({ chat_id: this.chatId, photo: photo.path, caption: text.slice(0, 1024) })
      : await this.api.sendMessage({ chat_id: this.chatId, text, disable_web_page_preview: true });

    if (!sent?.message_id) {
      throw new ProviderError('telegram returned no message id', 'unknown', false);
    }

    return {
      platformPostId: `${sent.chat.id}:${sent.message_id}`,
      ...(sent.chat.username ? { url: `https://t.me/${sent.chat.username}/${sent.message_id}` } : {}),
      publishedAt: new Date(sent.date * 1000),
    };
  }
}

/** Title and body become one message; Telegram has no title field. */
export function composeText(variant: DraftVariant): string {
  return variant.title ? `${variant.title}\n\n${variant.body}` : variant.body;
}
