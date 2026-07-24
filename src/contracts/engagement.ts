import type { ProviderInfo } from './common';

/**
 * Reads comments on your own posts and sends replies.
 *
 * Reuses the credential of the matching PublisherProvider account rather than
 * holding its own — one login per account, not per slot.
 *
 * INVARIANT: `reply()` is only called after an approval is granted, same gate
 * as publishing.
 */
export interface EngagementProvider {
  readonly info: ProviderInfo;
  readonly platform: string;

  listComments(post: PostRef, since?: Date): Promise<Comment[]>;

  reply(commentId: string, text: string, options: ReplyOptions): Promise<ReplyResult>;
}

export interface PostRef {
  /** MediaBot's own post id. */
  postId: string;
  /** The platform's id, as returned by PublishResult. */
  platformPostId: string;
  accountId: string;
}

export interface Comment {
  /** MUST be `"<platform>:<external id>"` so repeated polling is idempotent. */
  id: string;
  platform: string;
  postId: string;
  author?: string;
  body: string;
  publishedAt?: Date;
  /** Set when the comment is a reply to another comment. */
  parentId?: string;
}

export interface ReplyOptions {
  accountId: string;
  dryRun?: boolean;
}

export interface ReplyResult {
  platformReplyId: string;
  repliedAt: Date;
}
