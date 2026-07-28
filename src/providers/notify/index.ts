/**
 * Notifications for things that need a human.
 *
 * The approval queue only works if someone knows there is something in it. A
 * console you have to remember to open is a queue that silently stops moving,
 * so the daemon pushes a line when work lands.
 *
 * Notifications are best-effort by design: a failed webhook must never block
 * or fail the pipeline that produced the item. The item is already safely in
 * the queue — losing the ping is an inconvenience, losing the run is not.
 */

export interface Notification {
  title: string;
  body: string;
  /** Deep link back to the console. */
  url?: string;
  /**
   * Correlation token (`[mb:…]`) appended verbatim so a reply can be matched
   * back to the approval it decides. See core/approval-reply.ts.
   */
  token?: string;
}

export interface Notifier {
  readonly id: string;
  send(n: Notification): Promise<void>;
}

export interface WebhookNotifierOptions {
  url: string;
  /** Extra headers, e.g. an auth token. */
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** POSTs JSON to any endpoint — Slack, Discord, n8n, or your own bridge. */
export class WebhookNotifier implements Notifier {
  readonly id = 'webhook';

  constructor(private readonly opts: WebhookNotifierOptions) {}

  async send(n: Notification): Promise<void> {
    const fetchImpl = this.opts.fetchImpl ?? globalThis.fetch;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 10_000);

    try {
      const res = await fetchImpl(this.opts.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.opts.headers ?? {}) },
        // `text` carries the whole message so Slack/Discord-shaped receivers
        // render something useful without any mapping.
        body: JSON.stringify({
          text: [n.title, n.body, n.url, n.token].filter(Boolean).join('\n'),
          title: n.title,
          body: n.body,
          ...(n.url ? { url: n.url } : {}),
          ...(n.token ? { token: n.token } : {}),
        }),
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`webhook returned HTTP ${res.status}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface TelegramNotifierOptions {
  botToken: string;
  chatId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class TelegramNotifier implements Notifier {
  readonly id = 'telegram';

  constructor(private readonly opts: TelegramNotifierOptions) {}

  async send(n: Notification): Promise<void> {
    const fetchImpl = this.opts.fetchImpl ?? globalThis.fetch;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs ?? 10_000);

    try {
      const res = await fetchImpl(
        `https://api.telegram.org/bot${this.opts.botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: this.opts.chatId,
            // The token must survive verbatim, so no Markdown parsing here:
            // an unbalanced `*` or `_` in a draft makes Telegram reject the
            // whole message, and the notification is how the human finds out
            // there is anything to review at all.
            text: [n.title, n.body, n.url, n.token].filter(Boolean).join('\n'),
            disable_web_page_preview: true,
          }),
          signal: ctl.signal,
        },
      );
      if (!res.ok) throw new Error(`telegram returned HTTP ${res.status}`);
      const data = (await res.json()) as any;
      if (data?.ok === false) throw new Error(`telegram error: ${data.description ?? 'unknown'}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Fans out to every configured notifier, swallowing individual failures.
 *
 * Returns which ones failed so the daemon can log them without treating a
 * missed ping as a failed run.
 */
export async function notifyAll(
  notifiers: Notifier[],
  n: Notification,
): Promise<{ failed: { id: string; error: string }[] }> {
  const failed: { id: string; error: string }[] = [];

  await Promise.all(
    notifiers.map(async (notifier) => {
      try {
        await notifier.send(n);
      } catch (err) {
        failed.push({ id: notifier.id, error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  return { failed };
}

export interface NotifyConfig {
  webhookUrl?: string;
  webhookHeaders?: Record<string, string>;
  telegramBotToken?: string;
  telegramChatId?: string;
}

export function buildNotifiers(config: NotifyConfig = {}): Notifier[] {
  const out: Notifier[] = [];

  const webhookUrl = config.webhookUrl ?? process.env.MEDIABOT_WEBHOOK_URL;
  if (webhookUrl) {
    out.push(
      new WebhookNotifier({
        url: webhookUrl,
        ...(config.webhookHeaders ? { headers: config.webhookHeaders } : {}),
      }),
    );
  }

  const botToken = config.telegramBotToken ?? process.env.TELEGRAM_BOT_TOKEN;
  const chatId = config.telegramChatId ?? process.env.TELEGRAM_CHAT_ID;
  // Both halves are required; one without the other is a misconfiguration that
  // would otherwise fail silently on every send.
  if (botToken && chatId) out.push(new TelegramNotifier({ botToken, chatId }));

  return out;
}
