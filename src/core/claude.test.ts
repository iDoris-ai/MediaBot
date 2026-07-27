import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ClaudeError, extractFencedBlock, parseFencedJson, runClaude } from './claude';

/**
 * The stream parser is exercised against a fake `claude` binary that replays a
 * canned JSONL transcript, so these run in CI without a Claude login.
 */
function fakeClaude(script: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediabot-claude-'));
  const bin = path.join(dir, 'fake-claude');
  fs.writeFileSync(bin, script, { mode: 0o755 });
  return bin;
}

function withBin<T>(bin: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = bin;
  return fn().finally(() => {
    if (prev === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = prev;
  });
}

test('parses session id, text blocks, result and cost', async () => {
  const bin = fakeClaude(`#!/bin/sh
cat <<'JSONL'
{"type":"system","subtype":"init","session_id":"sess-abc"}
{"type":"assistant","message":{"content":[{"type":"text","text":"thinking "}]}}
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read"}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"out loud"}]}}
{"type":"result","result":"final summary","session_id":"sess-abc","total_cost_usd":0.0123}
JSONL
`);
  const events: string[] = [];
  const res = await withBin(bin, () =>
    runClaude('hi', { onEvent: (e) => events.push(e.type) }),
  );

  assert.equal(res.sessionId, 'sess-abc');
  assert.equal(res.text, 'final summary');
  assert.equal(res.transcript, 'thinking out loud');
  assert.equal(res.costUsd, 0.0123);
  assert.deepEqual(events, ['session', 'text', 'tool', 'text', 'result']);
});

test('ignores non-JSON debug lines instead of crashing', async () => {
  const bin = fakeClaude(`#!/bin/sh
cat <<'JSONL'
some debug noise from the CLI
{"type":"result","result":"ok"}
not json either
JSONL
`);
  const res = await withBin(bin, () => runClaude('hi'));
  assert.equal(res.text, 'ok');
});

test('handles a JSONL line split across stdout chunks', async () => {
  // Emit half a line, pause, then the rest — the parser must buffer, not drop it.
  const bin = fakeClaude(`#!/bin/sh
printf '{"type":"result","result":"spl'
sleep 0.2
printf 'it line"}\\n'
`);
  const res = await withBin(bin, () => runClaude('hi'));
  assert.equal(res.text, 'split line');
});

test('surfaces the model error text on non-zero exit', async () => {
  const bin = fakeClaude(`#!/bin/sh
echo '{"type":"result","result":"Credit balance too low"}'
exit 1
`);
  await assert.rejects(
    withBin(bin, () => runClaude('hi')),
    (err: unknown) => {
      assert.ok(err instanceof ClaudeError);
      assert.match(err.message, /Credit balance too low/);
      assert.equal(err.exitCode, 1);
      return true;
    },
  );
});

test('reports a clear error when the CLI is missing', async () => {
  await assert.rejects(
    withBin('/nonexistent/definitely-not-claude', () => runClaude('hi')),
    /not found/i,
  );
});

test('kills the subprocess on timeout', async () => {
  const bin = fakeClaude(`#!/bin/sh
sleep 30
`);
  await assert.rejects(withBin(bin, () => runClaude('hi', { timeoutMs: 1500 })), /timed out/i);
});

test('passes --model through to the CLI', async () => {
  // The fake echoes its own argv so we can assert on the flags we built.
  const bin = fakeClaude(`#!/bin/sh
printf '{"type":"result","result":"%s"}\\n' "$*"
`);
  const res = await withBin(bin, () => runClaude('hi', { model: 'claude-sonnet-5' }));
  assert.match(res.text, /--model claude-sonnet-5/);
});

test('extractFencedBlock finds tagged, untagged and absent blocks', () => {
  assert.equal(extractFencedBlock('before\n```json\n{"a":1}\n```\nafter'), '{"a":1}');
  assert.equal(extractFencedBlock('```\n{"a":2}\n```'), '{"a":2}');
  assert.equal(extractFencedBlock('no fence here'), null);
});

test('parseFencedJson returns null on malformed JSON rather than throwing', () => {
  assert.deepEqual(parseFencedJson('```json\n{"ok":true}\n```'), { ok: true });
  assert.equal(parseFencedJson('```json\n{ this is not json\n```'), null);
  assert.equal(parseFencedJson('plain prose'), null);
});

test('parses a JSON block whose payload contains fenced code', () => {
  // The failure this guards, seen with real Claude: a blog-tech draft carries
  // ```bash blocks inside its body string, and a first-closing-fence match
  // truncates mid-string.
  const output = [
    'Here is the content:',
    '```json',
    '{"variants":[{"platform":"blog-tech","body":"Run this:\\n\\n```bash\\nsysctl iogpu\\n```\\n\\nThen restart."}]}',
    '```',
    'Hope that helps.',
  ].join('\n');

  const parsed = parseFencedJson<{ variants: Array<{ body: string }> }>(output);
  assert.ok(parsed, 'a body containing code fences must still parse');
  assert.match(parsed!.variants[0]!.body, /sysctl iogpu/);
  assert.match(parsed!.variants[0]!.body, /Then restart\./, 'the block is not truncated at the inner fence');
});

test('parses a payload containing several fenced blocks', () => {
  const output =
    '```json\n' +
    '{"a":"first ```py\\nx=1\\n``` and second ```sh\\nls\\n``` done"}\n' +
    '```';
  const parsed = parseFencedJson<{ a: string }>(output);
  assert.ok(parsed);
  assert.match(parsed!.a, /done$/);
});

test('malformed JSON still yields null rather than a wrong parse', () => {
  assert.equal(parseFencedJson('```json\n{ broken ``` more ```\n```'), null);
});

test('trailing prose after the block does not break parsing', () => {
  const parsed = parseFencedJson<{ ok: boolean }>('```json\n{"ok":true}\n```\n\nLet me know!');
  assert.deepEqual(parsed, { ok: true });
});
