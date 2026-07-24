import http from 'http';
import type { Db } from '../core/db';
import { ApprovalQueue, type ApprovalState } from '../core/approval';
import { renderApp } from './ui';

/**
 * Local HTTP API and Web UI.
 *
 * Binds to loopback only. The database holds platform credentials and every
 * queued action is an outbound post waiting to happen, so this must never be
 * reachable off-box — a bound port is treated as a security boundary, not a
 * convenience.
 */

export interface ApiOptions {
  db: Db;
  port?: number;
  host?: string;
  /** Publish everything approved and due; wired to the pipeline by the daemon. */
  onExecute?: () => Promise<{ published: unknown[]; failed: unknown[] }>;
}

export function createServer(opts: ApiOptions): http.Server {
  const queue = new ApprovalQueue(opts.db);

  return http.createServer(async (req, res) => {
    // Defence in depth: even bound to loopback, refuse anything that did not
    // arrive over it (a misconfigured proxy could otherwise forward traffic in).
    const remote = req.socket.remoteAddress ?? '';
    if (!isLoopback(remote)) {
      send(res, 403, { error: 'MediaBot only serves localhost' });
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const route = `${req.method} ${url.pathname}`;

    try {
      if (route === 'GET /') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(renderApp());
        return;
      }

      if (route === 'GET /api/approvals') {
        const state = (url.searchParams.get('state') ?? 'pending') as ApprovalState;
        send(res, 200, { approvals: queue.list(state, 200) });
        return;
      }

      if (route === 'GET /api/status') {
        send(res, 200, status(opts.db));
        return;
      }

      if (route === 'GET /api/sources') {
        const rows = opts.db
          .prepare(
            `SELECT id, provider_id, kind, title, url, summary, published_at, fetched_at
               FROM source_items ORDER BY COALESCE(published_at, fetched_at) DESC LIMIT 100`,
          )
          .all();
        send(res, 200, { items: rows });
        return;
      }

      if (route === 'GET /api/posts') {
        const rows = opts.db
          .prepare(
            `SELECT id, platform, state, url, platform_post_id, scheduled_for, published_at, error
               FROM posts ORDER BY created_at DESC LIMIT 100`,
          )
          .all();
        send(res, 200, { posts: rows });
        return;
      }

      if (route === 'GET /api/runs') {
        const rows = opts.db
          .prepare(
            `SELECT id, kind, provider_id, state, detail, started_at, finished_at
               FROM runs ORDER BY started_at DESC LIMIT 100`,
          )
          .all();
        send(res, 200, { runs: rows });
        return;
      }

      if (req.method === 'POST' && url.pathname.startsWith('/api/approvals/')) {
        const [, , , id, action] = url.pathname.split('/');
        if (!id || !action) {
          send(res, 400, { error: 'expected /api/approvals/<id>/<approve|reject>' });
          return;
        }

        const body = await readJson(req);
        if (action === 'approve') {
          const approved = queue.approve(id, {
            by: 'web',
            // An edited payload is re-snapshotted and re-hashed by the queue, so
            // what ships is exactly what the reviewer saw after editing.
            ...(body.payload !== undefined ? { payload: body.payload } : {}),
            ...(body.scheduledFor !== undefined
              ? { scheduledFor: body.scheduledFor ? new Date(body.scheduledFor) : null }
              : {}),
          });
          const executed = body.executeNow !== false && opts.onExecute ? await opts.onExecute() : null;
          send(res, 200, { approval: approved, executed });
          return;
        }
        if (action === 'reject') {
          send(res, 200, { approval: queue.reject(id, { by: 'web', reason: body.reason }) });
          return;
        }
        send(res, 400, { error: `unknown action: ${action}` });
        return;
      }

      send(res, 404, { error: `no route for ${route}` });
    } catch (err) {
      send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

export function status(db: Db) {
  const count = (sql: string) => (db.prepare(sql).get() as any).c as number;
  return {
    pending: count(`SELECT COUNT(*) c FROM approvals WHERE state='pending'`),
    sourceItems: count(`SELECT COUNT(*) c FROM source_items`),
    drafts: count(`SELECT COUNT(*) c FROM drafts`),
    published: count(`SELECT COUNT(*) c FROM posts WHERE state='published'`),
    failed: count(`SELECT COUNT(*) c FROM posts WHERE state IN ('failed','dead')`),
    comments: count(`SELECT COUNT(*) c FROM comments WHERE state='new'`),
  };
}

export function isLoopback(addr: string): boolean {
  const a = addr.replace(/^::ffff:/, '');
  return a === '127.0.0.1' || a === '::1' || a.startsWith('127.');
}

function send(res: http.ServerResponse, code: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(json);
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // Bodies here are short edits; anything larger is a bug or an attack.
    if (size > 5 * 1024 * 1024) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}
