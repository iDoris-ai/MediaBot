import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TelegramNotifier,
  WebhookNotifier,
  buildNotifiers,
  notifyAll,
  type Notifier,
} from './index';

function captureFetch(
  calls: Array<{ url: string; body: any }>,
  response: { ok?: boolean; status?: number; json?: unknown } = {},
): typeof fetch {
  return (async (url: any, init?: any) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify(response.json ?? { ok: true }), {
      status: response.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

const message = { title: '3 条待审批', body: '小红书 2 条 / X 1 条', url: 'http://127.0.0.1:7788' };

test('webhook posts a flattened text plus structured fields', async () => {
  const calls: Array<{ url: string; body: any }> = [];
  await new WebhookNotifier({ url: 'https://hooks.example/x', fetchImpl: captureFetch(calls) }).send(message);

  assert.equal(calls[0]!.url, 'https://hooks.example/x');
  assert.match(calls[0]!.body.text, /3 条待审批/);
  assert.match(calls[0]!.body.text, /127\.0\.0\.1:7788/);
  assert.equal(calls[0]!.body.title, '3 条待审批');
});

test('webhook passes custom headers', async () => {
  let seen: any;
  const fetchImpl = (async (_u: any, init: any) => {
    seen = init.headers;
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;

  await new WebhookNotifier({
    url: 'https://x',
    headers: { authorization: 'Bearer t' },
    fetchImpl,
  }).send(message);

  assert.equal(seen.authorization, 'Bearer t');
  assert.equal(seen['content-type'], 'application/json');
});

test('a non-2xx webhook response is an error', async () => {
  const fetchImpl = captureFetch([], { status: 500 });
  await assert.rejects(
    new WebhookNotifier({ url: 'https://x', fetchImpl }).send(message),
    /HTTP 500/,
  );
});

test('telegram targets the bot API with the chat id', async () => {
  const calls: Array<{ url: string; body: any }> = [];
  await new TelegramNotifier({
    botToken: 'BOT:TOKEN',
    chatId: '12345',
    fetchImpl: captureFetch(calls),
  }).send(message);

  assert.match(calls[0]!.url, /api\.telegram\.org\/botBOT:TOKEN\/sendMessage/);
  assert.equal(calls[0]!.body.chat_id, '12345');
  assert.match(calls[0]!.body.text, /\*3 条待审批\*/);
});

test('telegram reports an API-level failure even on HTTP 200', async () => {
  const fetchImpl = captureFetch([], { json: { ok: false, description: 'chat not found' } });
  await assert.rejects(
    new TelegramNotifier({ botToken: 't', chatId: 'c', fetchImpl }).send(message),
    /chat not found/,
    'the bot API returns 200 with ok:false; treating that as success would hide a broken setup',
  );
});

test('notifyAll delivers to healthy notifiers even when one fails', async () => {
  const delivered: string[] = [];
  const good: Notifier = {
    id: 'good',
    send: async () => {
      delivered.push('good');
    },
  };
  const bad: Notifier = {
    id: 'bad',
    send: async () => {
      throw new Error('endpoint down');
    },
  };

  const res = await notifyAll([bad, good], message);

  assert.deepEqual(delivered, ['good']);
  assert.deepEqual(res.failed, [{ id: 'bad', error: 'endpoint down' }]);
});

test('notifyAll never throws — a missed ping must not fail the run', async () => {
  const allBroken: Notifier[] = [
    { id: 'a', send: async () => { throw new Error('x'); } },
    { id: 'b', send: async () => { throw new Error('y'); } },
  ];
  const res = await notifyAll(allBroken, message);
  assert.equal(res.failed.length, 2, 'the item is already queued; only the notification was lost');
});

test('notifyAll with no notifiers is a no-op', async () => {
  assert.deepEqual(await notifyAll([], message), { failed: [] });
});

test('buildNotifiers wires only what is fully configured', () => {
  assert.deepEqual(buildNotifiers({}).map((n) => n.id), []);
  assert.deepEqual(buildNotifiers({ webhookUrl: 'https://x' }).map((n) => n.id), ['webhook']);

  assert.deepEqual(
    buildNotifiers({ telegramBotToken: 'only-token' }).map((n) => n.id),
    [],
    'a token without a chat id would fail silently on every send',
  );
  assert.deepEqual(
    buildNotifiers({ telegramBotToken: 't', telegramChatId: 'c' }).map((n) => n.id),
    ['telegram'],
  );
});

test('buildNotifiers reads environment variables', () => {
  const prev = process.env.MEDIABOT_WEBHOOK_URL;
  process.env.MEDIABOT_WEBHOOK_URL = 'https://env-hook';
  try {
    assert.deepEqual(buildNotifiers().map((n) => n.id), ['webhook']);
  } finally {
    if (prev === undefined) delete process.env.MEDIABOT_WEBHOOK_URL;
    else process.env.MEDIABOT_WEBHOOK_URL = prev;
  }
});
