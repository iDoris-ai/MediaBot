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
 * Replies to your tweets, via the same `twitter` CLI as the publisher.
 */

export interface TwitterEngagementOptions {
  bin?: string;
  runner?: CliRunner;
  timeoutMs?: number;
  /** How many replies to pull per poll. */
  maxReplies?: number;
}

interface TwitterThreadResponse {
  data?: {
    replies?: Array<{
      id?: string;
      id_str?: string;
      text?: string;
      full_text?: string;
      created_at?: string;
      user?: { screenName?: string; screen_name?: string; username?: string };
      in_reply_to_status_id?: string;
    }>;
  };
}

export class TwitterEngagement implements EngagementProvider {
  readonly info: ProviderInfo = {
    id: 'twitter',
    slot: 'engagement',
    name: 'Twitter/X replies (twitter CLI)',
    upstream: 'twitter-cli',
  };
  readonly platform = 'twitter';

  private readonly bin: string;
  private readonly runner: CliRunner;
  private readonly timeoutMs: number;
  private readonly maxReplies: number;

  constructor(opts: TwitterEngagementOptions = {}) {
    this.bin = opts.bin ?? process.env.TWITTER_BIN ?? 'twitter';
    this.runner = opts.runner ?? defaultCliRunner;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.maxReplies = opts.maxReplies ?? 50;
  }

  async listComments(post: PostRef, since?: Date): Promise<Comment[]> {
    const res = await runJsonCli<TwitterThreadResponse>(
      this.runner,
      this.bin,
      ['tweet', post.platformPostId, '-n', String(this.maxReplies), '--json'],
      { timeoutMs: this.timeoutMs },
    );

    const out: Comment[] = [];
    for (const r of res?.data?.replies ?? []) {
      const externalId = r.id_str ?? r.id;
      if (!externalId) continue;

      const publishedAt = r.created_at ? new Date(r.created_at) : undefined;
      const valid = publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt : undefined;
      if (since && valid && valid < since) continue;

      const author = r.user?.screenName ?? r.user?.screen_name ?? r.user?.username;
      out.push({
        id: `${this.platform}:${externalId}`,
        platform: this.platform,
        postId: post.postId,
        ...(author ? { author } : {}),
        body: r.full_text ?? r.text ?? '',
        ...(valid ? { publishedAt: valid } : {}),
        ...(r.in_reply_to_status_id
          ? { parentId: `${this.platform}:${r.in_reply_to_status_id}` }
          : {}),
      });
    }
    return out;
  }

  async reply(commentId: string, text: string, options: ReplyOptions): Promise<ReplyResult> {
    if (options.dryRun) {
      return { platformReplyId: `dryrun_${commentId}`, repliedAt: new Date() };
    }

    // Unlike XHS, X replies address the tweet directly — no note id needed.
    const target = commentId.startsWith(`${this.platform}:`)
      ? commentId.slice(this.platform.length + 1)
      : commentId;

    const res = await runJsonCli<any>(this.runner, this.bin, ['reply', target, text, '--json'], {
      timeoutMs: this.timeoutMs,
    });

    const id = res?.data?.tweet_id ?? res?.data?.id;
    if (res?.ok === false || !id) {
      throw new ProviderError('twitter reply did not return a tweet id', 'unknown', false);
    }
    return { platformReplyId: String(id), repliedAt: new Date() };
  }
}
