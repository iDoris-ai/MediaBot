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
 * Reddit commenting from ONE openly-attributed account.
 *
 * Two things are deliberately absent:
 *
 * - **No upvote.** `rdt` can vote, and it is not wired here. Automated voting
 *   is vote manipulation under Reddit's rules even from a single account, and
 *   it is the behaviour their anti-abuse systems detect most reliably.
 * - **No multi-account support.** Several accounts presenting as independent
 *   people is astroturfing; it gets the linked accounts banned together and
 *   costs more in reputation than it ever saves in labour.
 *
 * What remains — finding threads worth answering and drafting a reply for a
 * human to approve — is where the labour actually goes.
 */

export interface RedditEngagementOptions {
  bin?: string;
  runner?: CliRunner;
  timeoutMs?: number;
}

export class RedditEngagement implements EngagementProvider {
  readonly info: ProviderInfo = {
    id: 'reddit',
    slot: 'engagement',
    name: 'Reddit comments (rdt CLI)',
    upstream: 'rdt-cli',
  };
  readonly platform = 'reddit';

  private readonly bin: string;
  private readonly runner: CliRunner;
  private readonly timeoutMs: number;

  constructor(opts: RedditEngagementOptions = {}) {
    this.bin = opts.bin ?? process.env.RDT_BIN ?? 'rdt';
    this.runner = opts.runner ?? defaultCliRunner;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  async listComments(post: PostRef, since?: Date): Promise<Comment[]> {
    const res = await runJsonCli<any>(
      this.runner,
      this.bin,
      ['read', post.platformPostId, '--json'],
      { timeoutMs: this.timeoutMs },
    );

    const out: Comment[] = [];
    for (const c of flattenComments(res)) {
      if (!c.id || !c.body) continue;

      const publishedAt = c.created_utc ? new Date(c.created_utc * 1000) : undefined;
      if (since && publishedAt && publishedAt < since) continue;

      out.push({
        id: `${this.platform}:${c.id}`,
        platform: this.platform,
        postId: post.postId,
        ...(c.author ? { author: c.author } : {}),
        body: c.body,
        ...(publishedAt ? { publishedAt } : {}),
        ...(c.parent_id ? { parentId: `${this.platform}:${stripKind(c.parent_id)}` } : {}),
      });
    }
    return out;
  }

  async reply(commentId: string, text: string, options: ReplyOptions): Promise<ReplyResult> {
    if (options.dryRun) {
      return { platformReplyId: `dryrun_${commentId}`, repliedAt: new Date() };
    }

    const target = commentId.startsWith(`${this.platform}:`)
      ? commentId.slice(this.platform.length + 1)
      : commentId;

    const res = await runJsonCli<any>(this.runner, this.bin, ['comment', target, text, '--json'], {
      timeoutMs: this.timeoutMs,
    });

    const id = res?.data?.id ?? res?.data?.name;
    if (res?.ok === false || !id) {
      throw new ProviderError('rdt comment returned no comment id', 'unknown', false);
    }
    return { platformReplyId: stripKind(String(id)), repliedAt: new Date() };
  }
}

/**
 * Pull comments out of Reddit's nested Listing structure.
 *
 * `rdt read` returns [post listing, comment listing]; comments nest replies
 * inside `replies`, and "more comments" placeholders appear as kind `more`.
 */
export function flattenComments(payload: any): any[] {
  const out: any[] = [];

  const walk = (node: any): void => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    // Placeholder for collapsed threads; it carries no body.
    if (node.kind === 'more') return;

    if (node.kind === 'Listing') {
      walk(node.data?.children);
      return;
    }
    if (node.kind === 't1' && node.data) {
      out.push(node.data);
      if (node.data.replies) walk(node.data.replies);
      return;
    }
    if (node.data && (node.data.children || node.data.body)) walk(node.data);
  };

  walk(payload?.data ?? payload);
  return out;
}

/** Reddit ids arrive prefixed with a kind, e.g. `t1_abc123`. */
function stripKind(id: string): string {
  return id.replace(/^t\d_/, '');
}
