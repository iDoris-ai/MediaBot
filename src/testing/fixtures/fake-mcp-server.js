#!/usr/bin/env node
/**
 * A real MCP stdio server used by the client tests.
 *
 * Testing the client against a hand-rolled mock of its own assumptions proves
 * little; this speaks the actual protocol over a real pipe, so a handshake or
 * framing mistake shows up.
 *
 * Behaviour is driven by MCP_FIXTURE_MODE:
 *   normal      — returns a JSON array of trend rows
 *   lines       — returns plain text lines
 *   tool_error  — returns isError
 *   no_tools    — advertises a different tool name
 *   crash       — exits during the first tools/call
 */
const mode = process.env.MCP_FIXTURE_MODE || 'normal';

const TRENDS = [
  { id: 't1', title: 'AI agent', value: 100, url: 'https://trends/1' },
  { id: 't2', title: 'vibe coding', value: 62 },
];

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function handle(msg) {
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-trends', version: '1.0.0' },
      },
    });
    return;
  }

  if (msg.method === 'notifications/initialized') return;

  if (msg.method === 'tools/list') {
    const name = mode === 'no_tools' ? 'something_else' : 'get_trends';
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { tools: [{ name, description: 'Fake trends', inputSchema: { type: 'object' } }] },
    });
    return;
  }

  if (msg.method === 'tools/call') {
    if (mode === 'crash') process.exit(1);

    if (mode === 'tool_error') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { isError: true, content: [{ type: 'text', text: 'quota exceeded' }] },
      });
      return;
    }

    if (mode === 'lines') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: 'first trend\nsecond trend\n' }] },
      });
      return;
    }

    const keyword = msg.params?.arguments?.query ?? '';
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        content: [
          { type: 'text', text: JSON.stringify({ items: TRENDS.map((t) => ({ ...t, keyword })) }) },
        ],
      },
    });
    return;
  }

  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
}
