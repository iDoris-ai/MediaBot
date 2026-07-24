import type { Comment, EngagementProvider } from '../contracts';
import { ProviderError } from '../contracts';
import { ApprovalQueue } from './approval';
import type { Db } from './db';
import { newId } from './identity';
import { runClaude, type ClaudeOptions } from './claude';

/**
 * The feedback loop: poll comments on your own posts, draft replies, and send
 * the ones a human approved.
 *
 * Replies go through the same approval gate as publishing. A reply is public,
 * attributed to you, and cannot be unsent — there is no reason it should have a
 * weaker guard than a post.
 */

export interface EngagementRunnerOptions {
  providers: EngagementProvider[];
  locale?: string;
  /** Voice guidance for drafted replies. */
  style?: string;
  /** Only draft for comments newer than this, in ms. */
  windowMs?: number;
  claude?: (prompt: string, opts?: ClaudeOptions) => Promise<{ text: string; transcript: string }>;
  now?: () => number;
}

export interface PollResult {
  fetched: number;
  stored: number;
  errors: { platform: string; message: string }[];
}

export interface DraftResult {
  drafted: number;
  queued: string[];
  skipped: { commentId: string; reason: string }[];
}

export interface ReplyResult {
  sent: { approvalId: string; commentId: string }[];
  failed: { approvalId: string; error: string }[];
}

export class EngagementRunner {
  private readonly approvals: ApprovalQueue;
  private readonly now: () => number;

  constructor(private readonly db: Db, private readonly opts: EngagementRunnerOptions) {
    this.now = opts.now ?? Date.now;
    this.approvals = new ApprovalQueue(db, this.now);
  }

  /** Fetch comments on every published post and store the new ones. */
  async poll(): Promise<PollResult> {
    const result: PollResult = { fetched: 0, stored: 0, errors: [] };

    const posts = this.db
      .prepare(
        `SELECT id, platform, account_id, platform_post_id
           FROM posts
          WHERE state = 'published' AND platform_post_id IS NOT NULL
          ORDER BY published_at DESC LIMIT 50`,
      )
      .all() as any[];

    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO comments (id, post_id, platform, author, body, published_at, state, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, 'new', ?)`,
    );

    for (const post of posts) {
      const provider = this.opts.providers.find((p) => p.platform === post.platform);
      if (!provider) continue;

      const runId = this.startRun('engage', provider.info.id, post.id);
      try {
        const comments = await provider.listComments({
          postId: post.id,
          platformPostId: post.platform_post_id,
          accountId: post.account_id,
        });
        result.fetched += comments.length;

        for (const c of comments) {
          const info = insert.run(
            c.id,
            post.id,
            c.platform,
            c.author ?? null,
            c.body,
            c.publishedAt ? c.publishedAt.getTime() : null,
            this.now(),
          );
          if (info.changes > 0) result.stored += 1;
        }
        this.finishRun(runId, 'ok', `${comments.length} comments`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push({ platform: post.platform, message });
        this.finishRun(runId, 'error', message);
      }
    }
    return result;
  }

  /**
   * Draft a reply for each new comment and queue it for approval.
   *
   * Nothing is sent here. A drafted reply sits in the same queue as a post.
   */
  async draftReplies(limit = 20): Promise<DraftResult> {
    const out: DraftResult = { drafted: 0, queued: [], skipped: [] };
    const cutoff = this.now() - (this.opts.windowMs ?? 7 * 24 * 3600_000);

    const comments = this.db
      .prepare(
        `SELECT c.id, c.post_id, c.platform, c.author, c.body, c.published_at,
                p.platform_post_id, p.account_id
           FROM comments c JOIN posts p ON p.id = c.post_id
          WHERE c.state = 'new' AND COALESCE(c.published_at, c.fetched_at) >= ?
          ORDER BY c.published_at DESC LIMIT ?`,
      )
      .all(cutoff, limit) as any[];

    for (const c of comments) {
      if (!c.body || !String(c.body).trim()) {
        // Sticker-only or empty comments have nothing to answer.
        this.setCommentState(c.id, 'ignored');
        out.skipped.push({ commentId: c.id, reason: 'empty comment' });
        continue;
      }

      const runner = this.opts.claude ?? ((p, o) => runClaude(p, o));
      let text: string;
      try {
        const res = await runner(buildReplyPrompt(c, this.opts.locale ?? 'zh-CN', this.opts.style));
        text = (res.text || res.transcript).trim();
      } catch (err) {
        out.skipped.push({
          commentId: c.id,
          reason: err instanceof Error ? err.message : 'draft failed',
        });
        continue;
      }

      if (!text || /^\s*(SKIP|PASS)\s*$/i.test(text)) {
        // The model is allowed to decline — some comments are better unanswered.
        this.setCommentState(c.id, 'ignored');
        out.skipped.push({ commentId: c.id, reason: 'model declined to reply' });
        continue;
      }

      this.db
        .prepare(`UPDATE comments SET state = 'drafted', reply_draft = ? WHERE id = ?`)
        .run(text, c.id);

      const approval = this.approvals.enqueue({
        kind: 'reply',
        refId: c.id,
        payload: {
          platform: c.platform,
          commentId: c.id,
          // XHS needs the note id alongside the comment id; carry both.
          replyTarget: replyTargetFor(c),
          accountId: c.account_id,
          author: c.author,
          inReplyTo: c.body,
          body: text,
        },
      });

      out.drafted += 1;
      out.queued.push(approval.id);
    }
    return out;
  }

  /** Send replies that were approved and are due. */
  async sendApproved(opts: { dryRun?: boolean } = {}): Promise<ReplyResult> {
    const out: ReplyResult = { sent: [], failed: [] };

    for (const approval of this.approvals.due()) {
      if (approval.kind !== 'reply') continue;

      let payload: any;
      try {
        payload = this.approvals.verifyForExecution(approval.id).payload;
      } catch (err) {
        out.failed.push({
          approvalId: approval.id,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      const provider = this.opts.providers.find((p) => p.platform === payload.platform);
      if (!provider) {
        out.failed.push({ approvalId: approval.id, error: `no engagement provider for ${payload.platform}` });
        continue;
      }

      const runId = this.startRun('reply', provider.info.id, payload.commentId);
      try {
        const res = await provider.reply(payload.replyTarget, payload.body, {
          accountId: payload.accountId,
          ...(opts.dryRun ? { dryRun: true } : {}),
        });
        this.db
          .prepare(`UPDATE comments SET state = 'replied', reply_platform_id = ? WHERE id = ?`)
          .run(res.platformReplyId, payload.commentId);

        out.sent.push({ approvalId: approval.id, commentId: payload.commentId });
        this.finishRun(runId, 'ok', res.platformReplyId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Leave the comment in `drafted` so a retry is possible; an auth error
        // needs a human anyway, so nothing is auto-retried here.
        out.failed.push({ approvalId: approval.id, error: message });
        this.finishRun(runId, 'error', message);
        if (err instanceof ProviderError && err.code === 'auth_expired') break;
      }
    }
    return out;
  }

  private setCommentState(id: string, state: string): void {
    this.db.prepare(`UPDATE comments SET state = ? WHERE id = ?`).run(state, id);
  }

  private startRun(kind: string, providerId?: string, refId?: string): string {
    const id = newId('run');
    this.db
      .prepare(
        `INSERT INTO runs (id, kind, provider_id, ref_id, state, started_at) VALUES (?,?,?,?, 'running', ?)`,
      )
      .run(id, kind, providerId ?? null, refId ?? null, this.now());
    return id;
  }

  private finishRun(id: string, state: 'ok' | 'error', detail?: string): void {
    this.db
      .prepare(`UPDATE runs SET state=?, detail=?, finished_at=? WHERE id=?`)
      .run(state, detail ?? null, this.now(), id);
  }
}

/**
 * XiaoHongShu replies address `<noteId>/<commentId>`; X addresses the tweet
 * directly. Encode that difference once, here, rather than in each provider.
 */
export function replyTargetFor(row: {
  platform: string;
  id: string;
  platform_post_id: string;
}): string {
  const externalCommentId = row.id.includes(':') ? row.id.split(':').slice(1).join(':') : row.id;
  return row.platform === 'xiaohongshu'
    ? `${row.platform_post_id}/${externalCommentId}`
    : externalCommentId;
}

export function buildReplyPrompt(
  comment: { author?: string; body: string; platform: string },
  locale: string,
  style?: string,
): string {
  return [
    `你在替账号主人回复${comment.platform}上的一条评论。用 ${locale} 写。`,
    style ? `语气：${style}` : '语气：真诚、具体、不客套。',
    '',
    '规则：',
    '- 只输出回复正文，不要解释、不要加引号',
    '- 简短（1-3 句），像真人随手回的',
    '- 不要以「感谢您的评论」这类套话开头',
    '- 如果评论是广告、辱骂、或明显不值得回复，只输出 SKIP',
    '',
    `评论者：${comment.author ?? '匿名'}`,
    `评论内容：${comment.body}`,
  ].join('\n');
}
