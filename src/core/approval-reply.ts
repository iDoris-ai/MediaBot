import { ApprovalQueue, type Approval } from './approval';

/**
 * Deciding an approval by replying to the notification.
 *
 * The queue only moves as fast as the human opens the console. In practice that
 * means drafts sit until evening, which defeats the point of scheduling them.
 * So the notification carries its own approval id and a reply decides it — the
 * phone that already buzzed becomes the review surface.
 *
 * Two properties this must not lose:
 *
 * 1. **Only the owner decides.** The notification usually lands in a group. A
 *    reply from anyone else is not a weaker approval, it is not an approval —
 *    it is a stranger publishing under your name. Authorisation is by numeric
 *    account id, never by display name (which anyone can copy).
 * 2. **A reply is a decision, not an edit.** Approve and reject only. Changing
 *    the text remotely would mean re-hashing a payload nobody re-read, so
 *    editing stays in the console.
 *
 * The `[mb:…]` correlation token is borrowed from openworker's inbox bindings
 * (`coworker/inbox_routing.py`, MIT, Copyright 2024 Andrew Ng).
 */

/** Approval ids are long; the token carries a prefix that is still unique. */
const TOKEN_CHARS = 12;
const TOKEN_RE = /\[mb:([A-Za-z0-9_]{6,})\]/;

export type ReplyDecision = 'approve' | 'reject';

export interface ParsedReply {
  /** The id fragment from the token — a prefix, not necessarily the full id. */
  idFragment: string;
  decision: ReplyDecision | null;
  /** Text after the token, kept for the rejection reason. */
  remainder: string;
}

/** The token to append to a notification so its reply can be correlated back. */
export function replyToken(approvalId: string): string {
  return `[mb:${approvalId.slice(0, TOKEN_CHARS)}]`;
}

const APPROVE_WORDS = ['批准', '通过', '同意', '可以', '发', 'approve', 'allow', 'ok', 'yes', 'y', '👍', '✅'];
const REJECT_WORDS = ['拒绝', '不行', '别发', '否', 'reject', 'deny', 'no', 'n', '👎', '❌'];

/**
 * Pull the approval id and the decision out of a reply.
 *
 * Returns null when there is no token: a group is full of ordinary chatter and
 * none of it should be read as a decision.
 */
export function parseApprovalReply(text: string): ParsedReply | null {
  const match = TOKEN_RE.exec(text ?? '');
  if (!match) return null;

  const remainder = (text.slice(0, match.index) + text.slice(match.index + match[0].length)).trim();
  const lowered = remainder.toLowerCase();

  // Reject wins a tie. "别发 ok" is someone reconsidering mid-sentence, and the
  // safe reading of an ambiguous instruction to publish is: do not publish.
  const rejected = REJECT_WORDS.some((w) => contains(lowered, w));
  const approved = APPROVE_WORDS.some((w) => contains(lowered, w));
  const decision: ReplyDecision | null = rejected ? 'reject' : approved ? 'approve' : null;

  return { idFragment: match[1]!, decision, remainder };
}

/**
 * ASCII words must match on a boundary so "no" inside "nothing" is not a
 * rejection; CJK and emoji have no boundaries, so those match as substrings.
 */
function contains(haystack: string, word: string): boolean {
  if (/^[a-z]+$/.test(word)) {
    return new RegExp(`(^|[^a-z])${word}([^a-z]|$)`).test(haystack);
  }
  return haystack.includes(word);
}

export interface ReplyApproverOptions {
  queue: ApprovalQueue;
  /**
   * The account allowed to decide. Required — with no owner there is no way to
   * tell an owner's reply from a stranger's, so the feature stays off.
   */
  ownerId: string;
  /** Label recorded as the decider. */
  by?: string;
}

export type ReplyOutcome =
  | { status: 'ignored'; reason: 'no_token' | 'not_owner' | 'no_decision' }
  | { status: 'unknown'; idFragment: string }
  | { status: 'already'; approval: Approval }
  | { status: 'decided'; decision: ReplyDecision; approval: Approval };

/**
 * Applies replies to the queue.
 *
 * Every rejection path returns a reason rather than throwing: this runs over a
 * live message stream where most messages are not for us, and a stray reply
 * must not take the poller down.
 */
export class ReplyApprover {
  private readonly queue: ApprovalQueue;
  private readonly ownerId: string;
  private readonly by: string;

  constructor(opts: ReplyApproverOptions) {
    if (!opts.ownerId) {
      throw new Error(
        'reply-approval needs an owner id — without one, any member of the chat could publish under your name',
      );
    }
    this.queue = opts.queue;
    this.ownerId = String(opts.ownerId);
    this.by = opts.by ?? 'telegram-reply';
  }

  /** `senderId` is the platform's numeric account id, never a display name. */
  apply(text: string, senderId: string | number | undefined): ReplyOutcome {
    const parsed = parseApprovalReply(text);
    if (!parsed) return { status: 'ignored', reason: 'no_token' };

    // Checked after parsing but before any lookup: an unauthorised sender must
    // not be able to probe which ids exist by watching the responses.
    if (senderId === undefined || String(senderId) !== this.ownerId) {
      return { status: 'ignored', reason: 'not_owner' };
    }
    if (!parsed.decision) return { status: 'ignored', reason: 'no_decision' };

    const approval = this.find(parsed.idFragment);
    if (!approval) return { status: 'unknown', idFragment: parsed.idFragment };
    // A second reply to the same item is a duplicate, not a change of mind —
    // re-deciding would silently overwrite an executed decision.
    if (approval.state !== 'pending') return { status: 'already', approval };

    const decided =
      parsed.decision === 'approve'
        ? this.queue.approve(approval.id, { by: this.by })
        : this.queue.reject(approval.id, {
            by: this.by,
            ...(parsed.remainder ? { reason: parsed.remainder } : {}),
          });

    return { status: 'decided', decision: parsed.decision, approval: decided };
  }

  /**
   * Resolve a token fragment to exactly one approval.
   *
   * An ambiguous prefix resolves to nothing rather than to the first match —
   * approving the wrong post is worse than not approving at all.
   */
  private find(fragment: string): Approval | undefined {
    const matches = (['pending', 'approved', 'rejected', 'expired'] as const).flatMap((state) =>
      this.queue.list(state, 200).filter((a) => a.id.startsWith(fragment)),
    );
    return matches.length === 1 ? matches[0] : undefined;
  }
}
