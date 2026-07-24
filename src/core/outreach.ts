import type { EngagementProvider, SourceItem } from '../contracts';
import { ApprovalQueue } from './approval';
import type { Db } from './db';
import { newId } from './identity';
import { runClaude, type ClaudeOptions } from './claude';

/**
 * Commenting on other people's posts, to be visible where your audience is.
 *
 * This is the one capability in MediaBot that acts on strangers' content, so it
 * carries the tightest constraints in the codebase:
 *
 * - hard daily caps per platform, enforced from the database, not memory
 * - randomised gaps: a comment exactly every N minutes is the clearest
 *   automation signal a platform can look for
 * - every comment still passes the approval gate
 * - the model is told to answer SKIP whenever it has nothing specific to add,
 *   and a generic comment is worse than silence — it costs reputation and gets
 *   the account flagged
 *
 * The caps are deliberately below what platforms tolerate. Volume is not the
 * point; being worth reading is.
 */

export interface OutreachOptions {
  providers: EngagementProvider[];
  /** Hard ceiling per platform per day. */
  dailyLimits?: Record<string, number>;
  /** Minimum gap between two comments on the same platform, in ms. */
  minGapMs?: number;
  /** Upper bound of the randomised gap. */
  maxGapMs?: number;
  locale?: string;
  style?: string;
  claude?: (prompt: string, opts?: ClaudeOptions) => Promise<{ text: string; transcript: string }>;
  now?: () => number;
  random?: () => number;
}

/** Conservative defaults — well under what each platform tolerates. */
export const DEFAULT_DAILY_LIMITS: Record<string, number> = {
  twitter: 20,
  xiaohongshu: 10,
  bilibili: 10,
};

export interface OutreachResult {
  queued: string[];
  skipped: { targetId: string; reason: string }[];
}

export class OutreachRunner {
  private readonly approvals: ApprovalQueue;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly db: Db, private readonly opts: OutreachOptions) {
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.approvals = new ApprovalQueue(db, this.now);
  }

  /** How many outbound comments went out on a platform today. */
  sentToday(platform: string): number {
    const dayStart = startOfDay(this.now());
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) c FROM runs
            WHERE kind = 'outreach' AND state = 'ok' AND provider_id = ? AND started_at >= ?`,
        )
        .get(platform, dayStart) as any
    ).c as number;
  }

  remainingToday(platform: string): number {
    const limit = this.opts.dailyLimits?.[platform] ?? DEFAULT_DAILY_LIMITS[platform] ?? 0;
    return Math.max(0, limit - this.sentToday(platform));
  }

  /** Has enough time passed since the last comment on this platform? */
  private gapElapsed(platform: string): boolean {
    const last = this.db
      .prepare(
        `SELECT started_at FROM runs
          WHERE kind = 'outreach' AND provider_id = ? ORDER BY started_at DESC LIMIT 1`,
      )
      .get(platform) as any;
    if (!last) return true;

    const min = this.opts.minGapMs ?? 3 * 60_000;
    const max = this.opts.maxGapMs ?? 7 * 60_000;
    // A fresh random gap each time, so the cadence never settles into a pattern.
    const required = min + this.random() * Math.max(0, max - min);
    return this.now() - last.started_at >= required;
  }

  /**
   * Draft comments on monitored posts and queue them for approval.
   *
   * Nothing is posted here. Targets come from the monitoring layer, which is
   * read-only — this is the only place its output can lead to an outbound
   * action, and it does so through the same gate as everything else.
   */
  async propose(targets: SourceItem[], limit = 5): Promise<OutreachResult> {
    const out: OutreachResult = { queued: [], skipped: [] };

    for (const target of targets.slice(0, limit)) {
      const platform = platformOf(target);
      if (!platform) {
        out.skipped.push({ targetId: target.id, reason: 'unknown platform' });
        continue;
      }
      if (!this.opts.providers.some((p) => p.platform === platform)) {
        out.skipped.push({ targetId: target.id, reason: `no provider for ${platform}` });
        continue;
      }
      if (this.remainingToday(platform) <= 0) {
        out.skipped.push({ targetId: target.id, reason: `daily limit reached for ${platform}` });
        continue;
      }
      if (!this.gapElapsed(platform)) {
        out.skipped.push({ targetId: target.id, reason: 'too soon since the last comment' });
        continue;
      }
      if (this.alreadyEngaged(target.id)) {
        out.skipped.push({ targetId: target.id, reason: 'already commented on this post' });
        continue;
      }

      const runner = this.opts.claude ?? ((p, o) => runClaude(p, o));
      let text: string;
      try {
        const res = await runner(
          buildOutreachPrompt(target, this.opts.locale ?? 'zh-CN', this.opts.style),
        );
        text = (res.text || res.transcript).trim();
      } catch (err) {
        out.skipped.push({
          targetId: target.id,
          reason: err instanceof Error ? err.message : 'draft failed',
        });
        continue;
      }

      if (!text || /^\s*SKIP\s*$/i.test(text)) {
        // Declining is the expected outcome most of the time.
        out.skipped.push({ targetId: target.id, reason: 'nothing specific to add' });
        continue;
      }

      const approval = this.approvals.enqueue({
        kind: 'reply',
        refId: target.id,
        payload: {
          platform,
          outbound: true,
          targetId: target.id,
          targetTitle: target.title,
          targetUrl: target.url,
          replyTarget: externalId(target.id),
          body: text,
        },
      });
      out.queued.push(approval.id);
    }

    return out;
  }

  /** Record that an outbound comment actually went out, for the daily cap. */
  recordSent(platform: string, targetId: string): void {
    const ts = this.now();
    this.db
      .prepare(
        `INSERT INTO runs (id, kind, provider_id, ref_id, state, started_at, finished_at)
         VALUES (?, 'outreach', ?, ?, 'ok', ?, ?)`,
      )
      .run(newId('run'), platform, targetId, ts, ts);
  }

  private alreadyEngaged(targetId: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM runs WHERE kind = 'outreach' AND ref_id = ? LIMIT 1`)
      .get(targetId);
    if (row) return true;
    // A pending approval counts too, or a re-run would queue a duplicate.
    return this.approvals
      .list('pending', 500)
      .some((a) => (a.payload as any)?.targetId === targetId);
  }
}

function platformOf(item: SourceItem): string | null {
  // Source ids look like "xhs-search:noteid"; map the provider back to a platform.
  const providerId = item.providerId;
  if (providerId.startsWith('xhs')) return 'xiaohongshu';
  if (providerId.startsWith('twitter')) return 'twitter';
  if (providerId.startsWith('bili')) return 'bilibili';
  return null;
}

function externalId(id: string): string {
  const i = id.indexOf(':');
  return i >= 0 ? id.slice(i + 1) : id;
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function buildOutreachPrompt(
  target: SourceItem,
  locale: string,
  style?: string,
): string {
  return [
    `你要在别人的帖子下留一条评论。用 ${locale} 写。`,
    style ? `语气：${style}` : '语气：像同行随口接一句，不是来推销的。',
    '',
    '硬性规则：',
    '- 只输出评论正文，不要解释',
    '- 必须针对这条帖子的具体内容，不能是放到哪都成立的空话',
    '- 不准提自己的产品、账号、链接',
    '- 不准以「说得好」「学到了」「同感」这类开头',
    '- 1-2 句，像真人打的字',
    '- **如果你没有具体的东西可补充，就只输出 SKIP**。一条泛泛的评论比不评论更糟——',
    '  它会消耗账号信誉，也容易被平台判定为营销号',
    '',
    `帖子标题：${target.title}`,
    target.summary ? `帖子内容：${target.summary.slice(0, 500)}` : '',
    target.url ? `链接：${target.url}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
