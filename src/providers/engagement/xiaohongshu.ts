import type {
  Comment,
  EngagementProvider,
  PostRef,
  ProviderInfo,
  ReplyOptions,
  ReplyResult,
} from '../../contracts';
import { ProviderError } from '../../contracts';
import { defaultCliRunner, runJsonCli, type CliRunner } from '../../core/cli-adapter';

/**
 * XiaoHongShu comments and replies, via the same `xhs` CLI as the publisher.
 *
 * Shares the tool's existing login rather than holding its own credential —
 * one login per account, not one per slot.
 */

export interface XhsEngagementOptions {
  bin?: string;
  runner?: CliRunner;
  timeoutMs?: number;
}

interface XhsCommentsResponse {
  data?: {
    comments?: Array<{
      id?: string;
      comment_id?: string;
      content?: string;
      create_time?: number;
      user?: { nickname?: string; name?: string };
      target_comment_id?: string;
    }>;
  };
}

export class XiaohongshuEngagement implements EngagementProvider {
  readonly info: ProviderInfo = {
    id: 'xhs',
    slot: 'engagement',
    name: 'XiaoHongShu comments (xhs CLI)',
    upstream: 'xhs-cli',
  };
  readonly platform = 'xiaohongshu';

  private readonly bin: string;
  private readonly runner: CliRunner;
  private readonly timeoutMs: number;

  constructor(opts: XhsEngagementOptions = {}) {
    this.bin = opts.bin ?? process.env.XHS_BIN ?? 'xhs';
    this.runner = opts.runner ?? defaultCliRunner;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  async listComments(post: PostRef, since?: Date): Promise<Comment[]> {
    const res = await runJsonCli<XhsCommentsResponse>(
      this.runner,
      this.bin,
      ['comments', post.platformPostId, '--all', '--json'],
      { timeoutMs: this.timeoutMs },
    );

    const raw = res?.data?.comments ?? [];
    const out: Comment[] = [];

    for (const c of raw) {
      const externalId = c.comment_id ?? c.id;
      if (!externalId) continue;

      // XHS returns create_time in seconds; Date wants milliseconds.
      const publishedAt = c.create_time ? new Date(c.create_time * 1000) : undefined;
      if (since && publishedAt && publishedAt < since) continue;

      out.push({
        // Namespaced so re-polling the same thread cannot duplicate rows.
        id: `${this.platform}:${externalId}`,
        platform: this.platform,
        postId: post.postId,
        ...(c.user?.nickname || c.user?.name ? { author: c.user.nickname ?? c.user.name! } : {}),
        body: c.content ?? '',
        ...(publishedAt ? { publishedAt } : {}),
        ...(c.target_comment_id ? { parentId: `${this.platform}:${c.target_comment_id}` } : {}),
      });
    }
    return out;
  }

  async reply(commentId: string, text: string, options: ReplyOptions): Promise<ReplyResult> {
    if (options.dryRun) {
      return { platformReplyId: `dryrun_${commentId}`, repliedAt: new Date() };
    }

    const { noteId, externalCommentId } = splitCommentRef(commentId);
    const res = await runJsonCli<any>(
      this.runner,
      this.bin,
      ['reply', noteId, '--comment-id', externalCommentId, '-c', text, '--json'],
      { timeoutMs: this.timeoutMs },
    );

    const replyId = res?.data?.comment_id ?? res?.data?.id;
    if (res?.ok === false || !replyId) {
      throw new ProviderError('xhs reply did not return a comment id', 'unknown', false);
    }
    return { platformReplyId: String(replyId), repliedAt: new Date() };
  }
}

/**
 * `xhs reply` needs both the note and the comment, so callers pass
 * `"<noteId>/<commentId>"` (optionally still carrying the platform prefix).
 */
export function splitCommentRef(ref: string): { noteId: string; externalCommentId: string } {
  const bare = ref.startsWith('xiaohongshu:') ? ref.slice('xiaohongshu:'.length) : ref;
  const slash = bare.lastIndexOf('/');
  if (slash < 0) {
    throw new ProviderError(
      `reply target must be "<noteId>/<commentId>", got "${ref}"`,
      'misconfigured',
      false,
    );
  }
  return { noteId: bare.slice(0, slash), externalCommentId: bare.slice(slash + 1) };
}
