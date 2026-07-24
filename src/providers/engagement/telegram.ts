import type {
  Comment,
  EngagementProvider,
  PostRef,
  ProviderInfo,
  ReplyOptions,
  ReplyResult,
} from '../../contracts';
import { ProviderError } from '../../contracts';
import { TelegramApi, shouldReply, type ReplyTrigger, type TelegramMessage } from '../telegram/api';

/**
 * Group messages that warrant an answer.
 *
 * `listComments` returns only messages that pass the reply trigger — a group
 * bot that answers everything gets muted or removed, so the filter lives here
 * rather than being left to the drafting stage. What reaches the approval queue
 * is already the subset worth a human's attention.
 */

export interface TelegramEngagementOptions {
  token: string;
  /** Groups to watch; empty means every chat the bot is in. */
  chatIds?: string[];
  trigger?: ReplyTrigger;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  limit?: number;
  /**
   * Called for every polled message, before any filtering.
   *
   * This exists so approval replies can be read without a second `getUpdates`
   * consumer — see providers/telegram/approval-poller.ts. It must not throw:
   * a hook failure would drop the messages this poll already acknowledged.
   */
  onMessage?: (message: TelegramMessage) => void;
}

export class TelegramEngagement implements EngagementProvider {
  readonly info: ProviderInfo = {
    id: 'telegram',
    slot: 'engagement',
    name: 'Telegram group replies',
    upstream: 'Telegram Bot API',
  };
  readonly platform = 'telegram';

  private readonly api: TelegramApi;
  private readonly chatIds: Set<string>;
  private readonly trigger: ReplyTrigger;
  private readonly limit: number;
  private offset: number | undefined;
  private botUsername: string | undefined;
  /** Assignable so the daemon can attach reply-approval after construction. */
  onMessage: ((message: TelegramMessage) => void) | undefined;

  constructor(opts: TelegramEngagementOptions) {
    this.api = new TelegramApi({
      token: opts.token,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
    this.chatIds = new Set(opts.chatIds ?? []);
    this.trigger = opts.trigger ?? {};
    this.limit = opts.limit ?? 50;
    this.onMessage = opts.onMessage;
  }

  /**
   * Poll for messages that should be answered.
   *
   * `post` is unused: Telegram messages are not comments on one of our posts,
   * they are group traffic. The parameter stays for contract compatibility.
   *
   * Offset handling is deliberately conservative. Advancing the offset acks the
   * updates with Telegram, so a crash between acking and storing would lose
   * them permanently. The offset only advances after a successful fetch, and
   * the namespaced ids make a re-read harmless.
   */
  async listComments(post: PostRef, since?: Date): Promise<Comment[]> {
    if (!this.botUsername && !this.trigger.botUsername) {
      try {
        const me = await this.api.getMe();
        this.botUsername = me.username;
      } catch {
        // Without a username, mentions cannot be detected; commands and
        // keywords still work, so this is degraded rather than fatal.
      }
    }

    const updates = await this.api.getUpdates({
      ...(this.offset !== undefined ? { offset: this.offset } : {}),
      limit: this.limit,
      timeout: 0,
    });

    if (updates.length) {
      this.offset = updates[updates.length - 1]!.update_id + 1;
    }

    const trigger: ReplyTrigger = {
      ...this.trigger,
      botUsername: this.trigger.botUsername ?? this.botUsername,
    };

    const out: Comment[] = [];
    for (const update of updates) {
      const msg = update.message;
      if (!msg) continue;

      // Before any filtering, and never allowed to break the poll: these
      // updates are already acknowledged, so throwing here would lose them.
      if (this.onMessage) {
        try {
          this.onMessage(msg);
        } catch {
          // Deliberately swallowed; the hook owns its own error reporting.
        }
      }

      if (this.chatIds.size && !this.chatIds.has(String(msg.chat.id))) continue;

      const publishedAt = new Date(msg.date * 1000);
      if (since && publishedAt < since) continue;

      if (!shouldReply(msg, trigger)) continue;

      out.push({
        id: `${this.platform}:${msg.chat.id}:${msg.message_id}`,
        platform: this.platform,
        postId: post.postId,
        ...(authorOf(msg) ? { author: authorOf(msg)! } : {}),
        body: msg.text ?? msg.caption ?? '',
        publishedAt,
      });
    }
    return out;
  }

  async reply(commentId: string, text: string, options: ReplyOptions): Promise<ReplyResult> {
    if (options.dryRun) {
      return { platformReplyId: `dryrun_${commentId}`, repliedAt: new Date() };
    }

    const { chatId, messageId } = parseTelegramRef(commentId);
    const sent = await this.api.sendMessage({
      chat_id: chatId,
      text,
      // Threading the reply keeps group context readable.
      reply_to_message_id: messageId,
      disable_web_page_preview: true,
    });

    if (!sent?.message_id) {
      throw new ProviderError('telegram reply returned no message id', 'unknown', false);
    }
    return { platformReplyId: String(sent.message_id), repliedAt: new Date(sent.date * 1000) };
  }
}

/** Comment ids are `telegram:<chatId>:<messageId>`. */
export function parseTelegramRef(ref: string): { chatId: string; messageId: number } {
  const bare = ref.startsWith('telegram:') ? ref.slice('telegram:'.length) : ref;
  const idx = bare.lastIndexOf(':');
  if (idx < 0) {
    throw new ProviderError(
      `telegram reply target must be "<chatId>:<messageId>", got "${ref}"`,
      'misconfigured',
      false,
    );
  }
  const messageId = Number(bare.slice(idx + 1));
  if (!Number.isInteger(messageId)) {
    throw new ProviderError(`invalid telegram message id in "${ref}"`, 'misconfigured', false);
  }
  return { chatId: bare.slice(0, idx), messageId };
}

function authorOf(msg: TelegramMessage): string | undefined {
  return msg.from?.username ?? msg.from?.first_name;
}
