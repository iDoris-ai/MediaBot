import { ReplyApprover, type ReplyOutcome } from '../../core/approval-reply';
import type { ApprovalQueue } from '../../core/approval';
import { TelegramApi, type TelegramMessage } from './api';
import type { TelegramEngagement } from '../engagement/telegram';

/**
 * Reading approval decisions out of Telegram.
 *
 * There is one hazard that shapes this whole file: **`getUpdates` is a
 * single-consumer stream.** Fetching with an offset acknowledges everything
 * before it, so two pollers on the same bot token do not each see every
 * message — they steal messages from each other, at random, permanently. A
 * missed group question is bad; a missed approval reply means the human thinks
 * they approved something that never went out.
 *
 * So this module never adds a second consumer. When the group-engagement
 * provider is configured it already owns the stream, and reply-approval rides
 * along on its messages. Only when nothing else is polling does a standalone
 * poller start. `wireReplyApproval` is that decision, in one place, testable.
 */

export interface ReplyApprovalConfig {
  /** Bot token; falls back to the engagement bot's token. */
  token?: string;
  /**
   * Numeric Telegram user id allowed to decide. Without it the whole feature
   * stays off — see ReplyApprover for why a display name is not enough.
   */
  ownerId?: string;
}

export type ReplyApprovalWiring =
  | { mode: 'disabled'; reason: string }
  | { mode: 'attached'; approver: ReplyApprover }
  | { mode: 'polling'; approver: ReplyApprover; poller: TelegramApprovalPoller };

/**
 * A standalone consumer of the update stream, used only when nothing else is.
 */
export class TelegramApprovalPoller {
  private readonly api: TelegramApi;
  private offset: number | undefined;

  constructor(
    private readonly approver: ReplyApprover,
    opts: { token: string; fetchImpl?: typeof fetch; timeoutMs?: number; limit?: number },
    private readonly limit = opts.limit ?? 50,
  ) {
    this.api = new TelegramApi({
      token: opts.token,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
  }

  /** One pass. Returns what it actually decided, for logging. */
  async poll(): Promise<ReplyOutcome[]> {
    const updates = await this.api.getUpdates({
      ...(this.offset !== undefined ? { offset: this.offset } : {}),
      limit: this.limit,
      timeout: 0,
    });
    if (updates.length) this.offset = updates[updates.length - 1]!.update_id + 1;

    const out: ReplyOutcome[] = [];
    for (const update of updates) {
      if (!update.message) continue;
      const outcome = handleMessage(this.approver, update.message);
      if (outcome.status !== 'ignored') out.push(outcome);
    }
    return out;
  }
}

/** Apply one message, whichever consumer it came from. */
export function handleMessage(approver: ReplyApprover, msg: TelegramMessage): ReplyOutcome {
  return approver.apply(msg.text ?? msg.caption ?? '', msg.from?.id);
}

/**
 * Decide how (and whether) reply-approval reads its messages.
 *
 * `engagement` is the group-reply provider if one is configured. When it is,
 * we attach — never poll — because it already owns the update stream.
 */
export function wireReplyApproval(input: {
  queue: ApprovalQueue;
  config: ReplyApprovalConfig;
  engagement?: TelegramEngagement | undefined;
  onOutcome?: (outcome: ReplyOutcome) => void;
  fetchImpl?: typeof fetch;
}): ReplyApprovalWiring {
  const { config } = input;
  if (!config.ownerId) {
    return {
      mode: 'disabled',
      reason: 'notify.telegramOwnerId is not set — replies cannot be told apart from anyone else in the chat',
    };
  }

  const approver = new ReplyApprover({ queue: input.queue, ownerId: config.ownerId });
  const report = (outcome: ReplyOutcome) => {
    if (outcome.status !== 'ignored') input.onOutcome?.(outcome);
  };

  if (input.engagement) {
    input.engagement.onMessage = (msg) => report(handleMessage(approver, msg));
    return { mode: 'attached', approver };
  }

  if (!config.token) {
    return { mode: 'disabled', reason: 'no telegram bot token to poll with' };
  }

  const poller = new TelegramApprovalPoller(approver, {
    token: config.token,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  return { mode: 'polling', approver, poller };
}
