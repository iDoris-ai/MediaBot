import { ProviderError } from '../../contracts';

/**
 * Thin Telegram Bot API client.
 *
 * Plain HTTP against api.telegram.org — no telethon, no MTProto. The Bot API
 * covers everything a group bot needs (send, reply, poll updates) and needs
 * only a token, where MTProto would need a phone-number session.
 */

const BASE = 'https://api.telegram.org';

export interface TelegramApiOptions {
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  text?: string;
  caption?: string;
  chat: { id: number; type: string; title?: string; username?: string };
  from?: { id: number; is_bot: boolean; username?: string; first_name?: string };
  reply_to_message?: { message_id: number; from?: { username?: string; is_bot?: boolean } };
  entities?: Array<{ type: string; offset: number; length: number }>;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export class TelegramApi {
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: TelegramApiOptions) {
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);

    try {
      const res = await this.fetchImpl(`${BASE}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: ctl.signal,
      });
      const body = (await res.json()) as { ok: boolean; result?: T; description?: string; error_code?: number };

      // The Bot API answers 200 with ok:false for real failures, so the HTTP
      // status alone would let a broken token look like success forever.
      if (!body.ok) {
        throw new ProviderError(
          `telegram ${method} failed: ${body.description ?? 'unknown'}`,
          classifyTelegramError(body.error_code, body.description),
          body.error_code === 429 || (body.error_code ?? 0) >= 500,
        );
      }
      return body.result as T;
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(
        `telegram ${method} request failed: ${err instanceof Error ? err.message : String(err)}`,
        'transient',
        true,
        err,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  getMe(): Promise<{ id: number; username?: string; first_name?: string }> {
    return this.call('getMe');
  }

  sendMessage(params: {
    chat_id: string | number;
    text: string;
    reply_to_message_id?: number;
    parse_mode?: string;
    disable_web_page_preview?: boolean;
  }): Promise<TelegramMessage> {
    return this.call('sendMessage', params);
  }

  sendPhoto(params: { chat_id: string | number; photo: string; caption?: string }): Promise<TelegramMessage> {
    return this.call('sendPhoto', params);
  }

  getUpdates(params: { offset?: number; limit?: number; timeout?: number }): Promise<TelegramUpdate[]> {
    return this.call('getUpdates', params);
  }
}

function classifyTelegramError(
  code: number | undefined,
  description: string | undefined,
): 'auth_expired' | 'rate_limited' | 'rejected' | 'transient' | 'misconfigured' | 'unknown' {
  if (code === 401) return 'auth_expired';
  if (code === 429) return 'rate_limited';
  if (code === 403) {
    // "bot was kicked" / "bot is not a member" — a human must re-add it.
    return 'misconfigured';
  }
  if (code === 400) return 'rejected';
  if ((code ?? 0) >= 500) return 'transient';
  return description ? 'unknown' : 'unknown';
}

/**
 * Should the bot answer this group message?
 *
 * A group bot that replies to everything gets muted or removed within a day, so
 * the triggers are explicit and narrow: it answers when addressed, when given a
 * command, or when a watched keyword appears. Everything else is left alone.
 */
export interface ReplyTrigger {
  /** The bot's own @username, used to detect mentions. */
  botUsername?: string;
  /** Reply when one of these appears in the text. */
  keywords?: string[];
  /** Reply to /commands addressed to this bot. */
  respondToCommands?: boolean;
}

export function shouldReply(message: TelegramMessage, trigger: ReplyTrigger): boolean {
  const text = message.text ?? message.caption ?? '';
  if (!text.trim()) return false;

  // Never answer another bot; two bots can loop on each other indefinitely.
  if (message.from?.is_bot) return false;

  // A direct chat with the bot is itself the address.
  if (message.chat.type === 'private') return true;

  const username = trigger.botUsername?.replace(/^@/, '');
  if (username) {
    if (text.includes(`@${username}`)) return true;
    if (message.reply_to_message?.from?.username === username) return true;
  }

  if (trigger.respondToCommands !== false && /^\/[a-z0-9_]+/i.test(text.trim())) return true;

  const lower = text.toLowerCase();
  return (trigger.keywords ?? []).some((k) => k.trim() && lower.includes(k.toLowerCase()));
}
