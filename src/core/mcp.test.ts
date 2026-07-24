import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { McpClient, textOf } from './mcp';
import { McpSource, parseToolOutput } from '../providers/source/mcp';
import { runConformance } from '../testing/conformance';
import { ProviderError } from '../contracts';

/** A real MCP server over a real pipe — not a mock of our own assumptions. */
const SERVER = path.join(__dirname, '..', 'testing', 'fixtures', 'fake-mcp-server.js');

function client(mode = 'normal', timeoutMs = 15_000) {
  return new McpClient({
    command: process.execPath,
    args: [SERVER],
    env: { MCP_FIXTURE_MODE: mode },
    timeoutMs,
  });
}

test('handshakes and lists tools', async () => {
  const c = client();
  try {
    const tools = await c.listTools();
    assert.deepEqual(tools.map((t) => t.name), ['get_trends']);
  } finally {
    c.close();
  }
});

test('calls a tool and returns its text content', async () => {
  const c = client();
  try {
    const text = await c.callTool('get_trends', { query: 'ai' });
    assert.match(text, /AI agent/);
    assert.match(text, /"keyword":"ai"/, 'arguments reach the server');
  } finally {
    c.close();
  }
});

test('connect is idempotent across concurrent calls', async () => {
  const c = client();
  try {
    const [a, b] = await Promise.all([c.listTools(), c.listTools()]);
    assert.deepEqual(a, b);
  } finally {
    c.close();
  }
});

test('a tool error surfaces as a ProviderError', async () => {
  const c = client('tool_error');
  try {
    await assert.rejects(c.callTool('get_trends', {}), (err: unknown) => {
      assert.ok(err instanceof ProviderError);
      assert.match(err.message, /quota exceeded/);
      return true;
    });
  } finally {
    c.close();
  }
});

test('a server that dies mid-call rejects rather than hanging', async () => {
  const c = client('crash');
  try {
    await assert.rejects(c.callTool('get_trends', {}), /exited with code/);
  } finally {
    c.close();
  }
});

test('a missing server binary is reported as misconfigured', async () => {
  const c = new McpClient({ command: '/nonexistent/mcp-server', timeoutMs: 5000 });
  try {
    await assert.rejects(c.listTools(), (err: unknown) => {
      assert.equal((err as ProviderError).code, 'misconfigured');
      assert.equal((err as ProviderError).retryable, false);
      return true;
    });
  } finally {
    c.close();
  }
});

test('a hung request times out instead of blocking forever', async () => {
  // Point at a process that never speaks the protocol.
  const c = new McpClient({ command: process.execPath, args: ['-e', 'setTimeout(()=>{},60000)'], timeoutMs: 1500 });
  try {
    await assert.rejects(c.listTools(), /timed out/);
  } finally {
    c.close();
  }
});

test('McpSource maps tool JSON into namespaced items', async () => {
  const s = new McpSource({ id: 'trends', server: { command: process.execPath, args: [SERVER] }, tool: 'get_trends' });
  try {
    const items = await s.fetch({ keywords: ['ai'] });
    assert.deepEqual(items.map((i) => i.id), ['trends:t1', 'trends:t2']);
    assert.equal(items[0]!.title, 'AI agent');
    assert.equal(items[0]!.score, 100, 'value maps to score');
    assert.equal(items[0]!.url, 'https://trends/1');
  } finally {
    s.close();
  }
});

test('McpSource ids are stable across polls', async () => {
  const s = new McpSource({ id: 'trends', server: { command: process.execPath, args: [SERVER] }, tool: 'get_trends' });
  try {
    const a = (await s.fetch({ keywords: ['ai'] })).map((i) => i.id);
    const b = (await s.fetch({ keywords: ['ai'] })).map((i) => i.id);
    assert.deepEqual(a, b);
  } finally {
    s.close();
  }
});

test('McpSource handles plain-text tool output', async () => {
  const s = new McpSource({
    id: 'lines',
    server: { command: process.execPath, args: [SERVER], env: { MCP_FIXTURE_MODE: 'lines' } },
    tool: 'get_trends',
  });
  try {
    const items = await s.fetch({ keywords: ['x'] });
    assert.deepEqual(items.map((i) => i.title), ['first trend', 'second trend']);
    assert.ok(items.every((i) => /^lines:[0-9a-f]{16}$/.test(i.id)), 'ids hash from content when absent');
  } finally {
    s.close();
  }
});

test('healthCheck reports a missing tool by name', async () => {
  const s = new McpSource({
    id: 'trends',
    server: { command: process.execPath, args: [SERVER], env: { MCP_FIXTURE_MODE: 'no_tools' } },
    tool: 'get_trends',
  });
  try {
    const h = await s.healthCheck();
    assert.equal(h.ok, false);
    assert.match(h.detail!, /has no tool "get_trends"/);
    assert.match(h.detail!, /something_else/, 'says what the server does offer');
  } finally {
    s.close();
  }
});

test('no keywords means no tool call', async () => {
  const s = new McpSource({ id: 'trends', server: { command: process.execPath, args: [SERVER] }, tool: 'get_trends' });
  try {
    assert.deepEqual(await s.fetch({}), []);
  } finally {
    s.close();
  }
});

test('McpSource passes the source conformance suite', async () => {
  const s = new McpSource({
    id: 'trends',
    server: { command: process.execPath, args: [SERVER] },
    tool: 'get_trends',
    keywords: ['ai'],
  });
  try {
    const report = await runConformance(s, 'source');
    assert.ok(report.passed, report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('\n'));
  } finally {
    s.close();
  }
});

test('parseToolOutput accepts arrays, wrappers, strings and lines', () => {
  assert.equal(parseToolOutput('[{"title":"a"}]').length, 1);
  assert.equal(parseToolOutput('{"results":[{"name":"b"}]}')[0]!.title, 'b');
  assert.equal(parseToolOutput('{"data":["c","d"]}').length, 2);
  assert.equal(parseToolOutput('plain one\nplain two').length, 2);
  assert.deepEqual(parseToolOutput('   '), []);
  assert.deepEqual(parseToolOutput('[{"noTitle":1}]'), [], 'rows without a title are dropped');
});

test('textOf flattens content blocks', () => {
  assert.equal(textOf({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.equal(textOf('raw string'), 'raw string');
});
