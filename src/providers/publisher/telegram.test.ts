import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TelegramPublisher, composeText } from './telegram';
import { TelegramEngagement, parseTelegramRef } from '../engagement/telegram';
import { shouldReply, type TelegramMessage } from '../telegram/api';
import { runConformance } from '../../testing/conformance';
import { ProviderError, type DraftVariant } from '../../contracts';

/** Records every Bot API call; nothing reaches api.telegram.org. */
function fakeApi(
  responses: Record<string, unknown>,
  calls: Array<{ method: string; params: any }> = [],
): typeof fetch {
  return (async (url: any, init?: any) => {
    const method = String(url).split('/').pop()!;
    const params = init?.body ? JSON.parse(init.body) : {};
    calls.push({ method, params });

    if (!(method in responses)) {
      return new Response(JSON.stringify({ ok: false, description: `no stub for ${method}`, error_code: 400 }));
    }
    const r = responses[method];
    return new Response(JSON.stringify(r && (r as any).ok === false ? r : { ok: true, result: r }));
  }) as unknown as typeof fetch;
}

const SENT = { message_id: 42, date: 1_780_000_000, chat: { id: -100123, type: 'supergroup', username: 'mygroup' } };
const ME = { id: 7, is_bot: true, username: 'mediabot' };

function variant(over: Partial<DraftVariant> = {}): DraftVariant {
  return { id: 'dv_1', platform: 'telegram', body: '今天的更新', media: [], ...over };
}

function message(over: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    message_id: 1,
    date: 1_780_000_000,
    text: 'hello everyone',
    chat: { id: -100123, type: 'supergroup' },
    from: { id: 9, is_bot: false, username: 'reader' },
    ...over,
  };
}

// --- publisher ------------------------------------------------------------

test('sends a text message to the configured chat', async () => {
  const calls: Array<{ method: string; params: any }> = [];
  const p = new TelegramPublisher({
    token: 't',
    chatId: '-100123',
    fetchImpl: fakeApi({ sendMessage: SENT }, calls),
  });

  const res = await p.publish(variant({ title: '标题' }), { accountId: 'a' });

  assert.equal(calls[0]!.method, 'sendMessage');
  assert.equal(calls[0]!.params.chat_id, '-100123');
  assert.equal(calls[0]!.params.text, '标题\n\n今天的更新');
  assert.equal(res.platformPostId, '-100123:42');
  assert.equal(res.url, 'https://t.me/mygroup/42');
});

test('the chat comes from configuration, not from generated content', async () => {
  const calls: Array<{ method: string; params: any }> = [];
  const p = new TelegramPublisher({
    token: 't',
    chatId: '-100123',
    fetchImpl: fakeApi({ sendMessage: SENT }, calls),
  });

  await p.publish(variant({ meta: { chat_id: '-999999' } }), { accountId: 'a' });
  assert.equal(
    calls[0]!.params.chat_id,
    '-100123',
    'a chat id in generated content must not be able to redirect the post',
  );
});

test('a title counts toward the 4096 budget', async () => {
  const p = new TelegramPublisher({ token: 't', chatId: 'c', fetchImpl: fakeApi({}) });
  const res = await p.validate(variant({ title: 'x'.repeat(100), body: 'y'.repeat(4000) }));

  assert.equal(res.ok, false);
  assert.match(res.errors[0]!.message, /including the title/);
});

test('an image is sent as a photo with the text as caption', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediabot-tg-'));
  const img = path.join(dir, 'a.png');
  fs.writeFileSync(img, 'x');

  const calls: Array<{ method: string; params: any }> = [];
  const p = new TelegramPublisher({ token: 't', chatId: 'c', fetchImpl: fakeApi({ sendPhoto: SENT }, calls) });

  await p.publish(variant({ media: [{ kind: 'image', path: img }] }), { accountId: 'a' });
  assert.equal(calls[0]!.method, 'sendPhoto');
  assert.equal(calls[0]!.params.caption, '今天的更新');
});

test('dry run sends nothing', async () => {
  const calls: Array<{ method: string; params: any }> = [];
  const p = new TelegramPublisher({ token: 't', chatId: 'c', fetchImpl: fakeApi({ sendMessage: SENT }, calls) });

  await p.publish(variant(), { accountId: 'a', dryRun: true });
  assert.equal(calls.length, 0);
});

test('ok:false on HTTP 200 is an error, and 401 is not retried', async () => {
  const p = new TelegramPublisher({
    token: 'bad',
    chatId: 'c',
    fetchImpl: fakeApi({ sendMessage: { ok: false, description: 'Unauthorized', error_code: 401 } }),
  });

  await assert.rejects(p.publish(variant(), { accountId: 'a' }), (err: unknown) => {
    assert.ok(err instanceof ProviderError);
    assert.equal(err.code, 'auth_expired');
    assert.equal(err.retryable, false, 'a bad token will not fix itself by retrying');
    return true;
  });
});

test('being kicked from the group is misconfigured, not transient', async () => {
  const p = new TelegramPublisher({
    token: 't',
    chatId: 'c',
    fetchImpl: fakeApi({ sendMessage: { ok: false, description: 'bot was kicked', error_code: 403 } }),
  });
  await assert.rejects(p.publish(variant(), { accountId: 'a' }), (err: unknown) => {
    assert.equal((err as ProviderError).code, 'misconfigured');
    assert.equal((err as ProviderError).retryable, false, 'a human must re-add the bot');
    return true;
  });
});

test('publisher passes the conformance suite', async () => {
  const p = new TelegramPublisher({
    token: 't',
    chatId: 'c',
    fetchImpl: fakeApi({ getMe: ME, sendMessage: SENT }),
  });
  const report = await runConformance(p, 'publisher');
  assert.ok(report.passed, report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('\n'));
});

// --- reply trigger: the critical constraint --------------------------------

test('an ordinary group message is NOT answered', () => {
  assert.equal(
    shouldReply(message({ text: '大家早上好' }), { botUsername: 'mediabot', keywords: ['价格'] }),
    false,
    'a bot that answers every message gets muted or removed within a day',
  );
});

test('a mention is answered', () => {
  assert.equal(shouldReply(message({ text: '@mediabot 这个怎么装' }), { botUsername: 'mediabot' }), true);
  assert.equal(shouldReply(message({ text: '@mediabot 这个怎么装' }), { botUsername: '@mediabot' }), true);
});

test('a reply to the bot is answered', () => {
  const msg = message({
    text: '那这个呢',
    reply_to_message: { message_id: 5, from: { username: 'mediabot' } },
  });
  assert.equal(shouldReply(msg, { botUsername: 'mediabot' }), true);
});

test('a command is answered', () => {
  assert.equal(shouldReply(message({ text: '/help' }), {}), true);
  assert.equal(shouldReply(message({ text: '/help' }), { respondToCommands: false }), false);
});

test('a watched keyword is answered, case-insensitively', () => {
  assert.equal(shouldReply(message({ text: '请问 PNTs 怎么领' }), { keywords: ['pnts'] }), true);
  assert.equal(shouldReply(message({ text: '随便聊聊' }), { keywords: ['pnts'] }), false);
});

test('private chats are always answered', () => {
  assert.equal(shouldReply(message({ chat: { id: 9, type: 'private' } }), {}), true);
});

test('other bots are never answered', () => {
  const fromBot = message({ text: '@mediabot hi', from: { id: 1, is_bot: true, username: 'otherbot' } });
  assert.equal(
    shouldReply(fromBot, { botUsername: 'mediabot' }),
    false,
    'two bots addressing each other can loop indefinitely',
  );
});

test('an empty message is never answered', () => {
  assert.equal(shouldReply(message({ text: '   ' }), { botUsername: 'mediabot' }), false);
});

// --- engagement -----------------------------------------------------------

test('listComments returns only messages that pass the trigger', async () => {
  const updates = [
    { update_id: 1, message: message({ message_id: 1, text: '闲聊一句' }) },
    { update_id: 2, message: message({ message_id: 2, text: '@mediabot 问一下' }) },
    { update_id: 3, message: message({ message_id: 3, text: '/status' }) },
  ];
  const e = new TelegramEngagement({
    token: 't',
    trigger: { botUsername: 'mediabot' },
    fetchImpl: fakeApi({ getMe: ME, getUpdates: updates }),
  });

  const comments = await e.listComments({ postId: 'p', platformPostId: 'x', accountId: 'a' });

  assert.deepEqual(
    comments.map((c) => c.id),
    ['telegram:-100123:2', 'telegram:-100123:3'],
    'the plain chatter is filtered out before it reaches the approval queue',
  );
});

test('only watched chats are polled when chatIds is set', async () => {
  const updates = [
    { update_id: 1, message: message({ message_id: 1, text: '/x', chat: { id: -111, type: 'supergroup' } }) },
    { update_id: 2, message: message({ message_id: 2, text: '/x', chat: { id: -222, type: 'supergroup' } }) },
  ];
  const e = new TelegramEngagement({
    token: 't',
    chatIds: ['-222'],
    fetchImpl: fakeApi({ getMe: ME, getUpdates: updates }),
  });

  const comments = await e.listComments({ postId: 'p', platformPostId: 'x', accountId: 'a' });
  assert.deepEqual(comments.map((c) => c.id), ['telegram:-222:2']);
});

test('the offset advances so updates are not re-read forever', async () => {
  const calls: Array<{ method: string; params: any }> = [];
  const e = new TelegramEngagement({
    token: 't',
    fetchImpl: fakeApi({ getMe: ME, getUpdates: [{ update_id: 77, message: message({ text: '/x' }) }] }, calls),
  });

  await e.listComments({ postId: 'p', platformPostId: 'x', accountId: 'a' });
  await e.listComments({ postId: 'p', platformPostId: 'x', accountId: 'a' });

  const offsets = calls.filter((c) => c.method === 'getUpdates').map((c) => c.params.offset);
  assert.equal(offsets[0], undefined, 'the first poll has no offset');
  assert.equal(offsets[1], 78, 'the second acks past the last update');
});

test('since filters older messages', async () => {
  const updates = [
    { update_id: 1, message: message({ message_id: 1, text: '/old', date: 1_700_000_000 }) },
    { update_id: 2, message: message({ message_id: 2, text: '/new', date: 1_800_000_000 }) },
  ];
  const e = new TelegramEngagement({ token: 't', fetchImpl: fakeApi({ getMe: ME, getUpdates: updates }) });

  const comments = await e.listComments(
    { postId: 'p', platformPostId: 'x', accountId: 'a' },
    new Date(1_750_000_000_000),
  );
  assert.deepEqual(comments.map((c) => c.id), ['telegram:-100123:2']);
});

test('reply threads onto the original message', async () => {
  const calls: Array<{ method: string; params: any }> = [];
  const e = new TelegramEngagement({ token: 't', fetchImpl: fakeApi({ sendMessage: SENT }, calls) });

  const res = await e.reply('telegram:-100123:5', '这样装', { accountId: 'a' });

  assert.equal(calls[0]!.params.chat_id, '-100123');
  assert.equal(calls[0]!.params.reply_to_message_id, 5, 'threading keeps group context readable');
  assert.equal(res.platformReplyId, '42');
});

test('dry-run reply calls nothing', async () => {
  const calls: Array<{ method: string; params: any }> = [];
  const e = new TelegramEngagement({ token: 't', fetchImpl: fakeApi({ sendMessage: SENT }, calls) });
  await e.reply('telegram:-100:1', 'hi', { accountId: 'a', dryRun: true });
  assert.equal(calls.length, 0);
});

test('parseTelegramRef rejects a malformed target', () => {
  assert.deepEqual(parseTelegramRef('telegram:-100123:5'), { chatId: '-100123', messageId: 5 });
  assert.deepEqual(parseTelegramRef('-100123:5'), { chatId: '-100123', messageId: 5 });
  assert.throws(() => parseTelegramRef('nochatid'), ProviderError);
  assert.throws(() => parseTelegramRef('telegram:-100:abc'), ProviderError);
});

test('engagement passes the conformance suite', async () => {
  const e = new TelegramEngagement({ token: 't', fetchImpl: fakeApi({ getMe: ME, getUpdates: [] }) });
  const report = await runConformance(e, 'engagement');
  assert.ok(report.passed, report.checks.filter((c) => !c.ok).map((c) => c.detail).join('\n'));
});

test('composeText joins title and body', () => {
  assert.equal(composeText({ id: 'x', platform: 'telegram', title: 'T', body: 'B', media: [] }), 'T\n\nB');
  assert.equal(composeText({ id: 'x', platform: 'telegram', body: 'B', media: [] }), 'B');
});
