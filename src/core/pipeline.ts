import type {
  ComposerProvider,
  ContentBrief,
  DraftVariant,
  PublisherProvider,
  SourceItem,
  SourceProvider,
  SourceQuery,
} from '../contracts';
import { ProviderError } from '../contracts';
import { ApprovalQueue, type Approval } from './approval';
import { auditJson, redactText } from './audit';
import { publishGrant } from './consequence';
import type { Db } from './db';
import { backoffMs, idempotencyKey, newId } from './identity';

/**
 * Wires the slots into the run loop described in docs/spec.md §3:
 *
 *   ingest → compose → validate → approve → publish
 *
 * The pipeline owns persistence and the approval boundary; providers stay
 * ignorant of the database entirely.
 */

export interface PipelineProviders {
  sources?: SourceProvider[];
  composer?: ComposerProvider;
  publishers?: PublisherProvider[];
}

export interface IngestResult {
  fetched: number;
  stored: number;
  items: SourceItem[];
  errors: { providerId: string; message: string }[];
}

export interface ProposeResult {
  approvals: Approval[];
  skipped: { platform: string; reason: string }[];
}

export interface ExecuteResult {
  published: { approvalId: string; postId: string; url?: string }[];
  failed: { approvalId: string; error: string; willRetry: boolean }[];
}

export class Pipeline {
  private readonly approvals: ApprovalQueue;

  constructor(
    private readonly db: Db,
    private readonly providers: PipelineProviders,
    private readonly now: () => number = Date.now,
  ) {
    this.approvals = new ApprovalQueue(db, now);
  }

  get queue(): ApprovalQueue {
    return this.approvals;
  }

  /**
   * Poll every source and persist what is new.
   *
   * One provider failing must not lose the others' results, so errors are
   * collected rather than thrown.
   */
  async ingest(query: SourceQuery = {}): Promise<IngestResult> {
    const result: IngestResult = { fetched: 0, stored: 0, items: [], errors: [] };
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO source_items
         (id, provider_id, kind, title, url, summary, score, locale, published_at, raw, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const source of this.providers.sources ?? []) {
      const runId = this.startRun('source_poll', source.info.id, undefined, query);
      try {
        const items = await source.fetch(query);
        result.fetched += items.length;

        for (const item of items) {
          const info = insert.run(
            item.id,
            item.providerId,
            item.kind,
            item.title,
            item.url ?? null,
            item.summary ?? null,
            item.score ?? null,
            item.locale ?? null,
            item.publishedAt ? item.publishedAt.getTime() : null,
            item.raw === undefined ? null : JSON.stringify(item.raw),
            this.now(),
          );
          // changes === 0 means the id already existed: a re-poll, not new material.
          if (info.changes > 0) {
            result.stored += 1;
            result.items.push(item);
          }
        }
        this.finishRun(runId, 'ok', `fetched ${items.length}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push({ providerId: source.info.id, message });
        this.finishRun(runId, 'error', message);
      }
    }
    return result;
  }

  /** Run the composer and persist the draft and its variants. */
  async compose(brief: ContentBrief): Promise<{ draftId: string; variants: DraftVariant[] }> {
    const composer = this.providers.composer;
    if (!composer) throw new Error('no composer configured');

    const runId = this.startRun('compose', composer.info.id, undefined, briefForStorage(brief));
    const createdAt = this.now();

    try {
      const draft = await composer.compose(brief);
      this.db.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO drafts (id, brief, composer_id, state, created_at, updated_at)
             VALUES (?, ?, ?, 'ready', ?, ?)`,
          )
          .run(draft.id, JSON.stringify(briefForStorage(brief)), composer.info.id, createdAt, createdAt);

        const insertVariant = this.db.prepare(
          `INSERT INTO draft_variants (id, draft_id, platform, title, body, media, meta, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const v of draft.variants) {
          insertVariant.run(
            v.id,
            draft.id,
            v.platform,
            v.title ?? null,
            v.body,
            JSON.stringify(v.media),
            v.meta ? JSON.stringify(v.meta) : null,
            createdAt,
          );
        }
      })();

      this.finishRun(runId, 'ok', `${draft.variants.length} variants`);
      return { draftId: draft.id, variants: draft.variants };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Record the failed attempt so the UI can show why nothing appeared.
      this.db
        .prepare(
          `INSERT INTO drafts (id, brief, composer_id, state, error, created_at, updated_at)
           VALUES (?, ?, ?, 'discarded', ?, ?, ?)`,
        )
        .run(newId('draft'), JSON.stringify(briefForStorage(brief)), composer.info.id, message, createdAt, createdAt);
      this.finishRun(runId, 'error', message);
      throw err;
    }
  }

  /**
   * Validate each variant against its platform and queue it for approval.
   *
   * Nothing reaches a platform from here — this only produces pending items.
   */
  async propose(
    variants: DraftVariant[],
    opts: { scheduledFor?: Date } = {},
  ): Promise<ProposeResult> {
    const out: ProposeResult = { approvals: [], skipped: [] };

    for (const variant of variants) {
      const publisher = this.publisherFor(variant.platform);
      if (!publisher) {
        out.skipped.push({ platform: variant.platform, reason: 'no publisher configured' });
        continue;
      }

      const validation = await publisher.validate(variant);
      this.db
        .prepare(`UPDATE draft_variants SET validation = ? WHERE id = ?`)
        .run(JSON.stringify(validation), variant.id);

      if (!validation.ok) {
        out.skipped.push({
          platform: variant.platform,
          reason: validation.errors.map((e) => e.code).join(', ') || 'validation failed',
        });
        continue;
      }

      const grant = publishGrant(publisher, variant);
      out.approvals.push(
        this.approvals.enqueue({
          kind: 'publish',
          refId: variant.id,
          payload: variant,
          scheduledFor: opts.scheduledFor ?? null,
          ...(grant ? { grant } : {}),
        }),
      );
    }
    return out;
  }

  /**
   * Publish everything approved and due.
   *
   * Each item is hash-verified immediately before it goes out, and recorded
   * under a UNIQUE idempotency key so a crash mid-run cannot double-publish on
   * the next pass.
   */
  async executeDue(opts: { dryRun?: boolean } = {}): Promise<ExecuteResult> {
    const out: ExecuteResult = { published: [], failed: [] };

    for (const approval of this.approvals.due()) {
      if (approval.kind !== 'publish') continue;

      const runId = this.startRun('publish', undefined, approval.id, {
        approvalId: approval.id,
        scheduledFor: approval.scheduledFor,
        decidedBy: approval.decidedBy,
      });
      let variant: DraftVariant;
      try {
        variant = this.approvals.verifyForExecution(approval.id).payload as DraftVariant;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        out.failed.push({ approvalId: approval.id, error: message, willRetry: false });
        this.finishRun(runId, 'error', message);
        continue;
      }

      const publisher = this.publisherFor(variant.platform);
      if (!publisher) {
        out.failed.push({ approvalId: approval.id, error: 'no publisher configured', willRetry: false });
        this.finishRun(runId, 'error', 'no publisher configured');
        continue;
      }

      const accountId = this.ensureAccount(publisher);
      this.setRunArgs(runId, {
        approvalId: approval.id,
        decidedBy: approval.decidedBy,
        platform: variant.platform,
        variantId: variant.id,
        accountId,
        transport: publisher.transport,
        title: variant.title,
        body: variant.body,
        media: variant.media.map((m) => ({ kind: m.kind, path: m.path })),
      });
      const scheduledFor = approval.scheduledFor ?? 0;
      const key = idempotencyKey({ accountId, draftVariantId: variant.id, scheduledFor });
      const postId = this.claimPost({ approval, variant, accountId, key, scheduledFor });

      if (!postId) {
        // The UNIQUE constraint rejected the insert: this exact publish already
        // happened on an earlier pass. Silently done, not an error.
        this.finishRun(runId, 'ok', 'already published (idempotent skip)');
        continue;
      }

      try {
        const res = await publisher.publish(variant, {
          accountId,
          ...(approval.scheduledFor ? { scheduledFor: new Date(approval.scheduledFor) } : {}),
          ...(opts.dryRun ? { dryRun: true } : {}),
        });
        this.db
          .prepare(
            `UPDATE posts SET state='published', platform_post_id=?, url=?, published_at=?, updated_at=?
              WHERE id=?`,
          )
          .run(res.platformPostId, res.url ?? null, res.publishedAt.getTime(), this.now(), postId);

        out.published.push({ approvalId: approval.id, postId, ...(res.url ? { url: res.url } : {}) });
        this.finishRun(runId, 'ok', res.platformPostId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const retryable = err instanceof ProviderError ? err.retryable : true;
        const attempts =
          ((this.db.prepare(`SELECT attempts FROM posts WHERE id=?`).get(postId) as any)?.attempts ?? 0) + 1;
        const delay = retryable ? backoffMs(attempts) : null;

        this.db
          .prepare(`UPDATE posts SET state=?, attempts=?, error=?, scheduled_for=?, updated_at=? WHERE id=?`)
          .run(
            delay === null ? 'dead' : 'queued',
            attempts,
            message,
            delay === null ? null : this.now() + delay,
            this.now(),
            postId,
          );

        out.failed.push({ approvalId: approval.id, error: message, willRetry: delay !== null });
        this.finishRun(runId, 'error', message);
      }
    }
    return out;
  }

  /** One pass of the whole loop, for the CLI's `run` command. */
  async runOnce(
    brief: Omit<ContentBrief, 'sources'>,
    opts: { query?: SourceQuery; autoApprove?: boolean; dryRun?: boolean } = {},
  ): Promise<{ ingest: IngestResult; propose: ProposeResult; execute?: ExecuteResult }> {
    const ingest = await this.ingest(opts.query ?? {});
    const { variants } = await this.compose({ ...brief, sources: ingest.items });
    const propose = await this.propose(variants);

    if (!opts.autoApprove) return { ingest, propose };

    for (const a of propose.approvals) this.approvals.approve(a.id, { by: 'auto' });
    const execute = await this.executeDue({ ...(opts.dryRun ? { dryRun: true } : {}) });
    return { ingest, propose, execute };
  }

  private publisherFor(platform: string): PublisherProvider | undefined {
    return (this.providers.publishers ?? []).find((p) => p.platform === platform);
  }

  /** Reuse the account row for a platform, creating one on first use. */
  private ensureAccount(publisher: PublisherProvider): string {
    const existing = this.db
      .prepare(`SELECT id FROM accounts WHERE platform = ? AND display_name = ?`)
      .get(publisher.platform, 'default') as any;
    if (existing) return existing.id;

    const id = newId('acc');
    const ts = this.now();
    this.db
      .prepare(
        `INSERT INTO accounts (id, platform, provider_id, transport, display_name, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'default', 'active', ?, ?)`,
      )
      .run(id, publisher.platform, publisher.info.id, publisher.transport, ts, ts);
    return id;
  }

  /**
   * Insert the post row, or return null when this publish already happened.
   *
   * The UNIQUE index on idempotency_key is what makes replay safe; a row that
   * is already `published` must never be re-sent.
   */
  private claimPost(input: {
    approval: Approval;
    variant: DraftVariant;
    accountId: string;
    key: string;
    scheduledFor: number;
  }): string | null {
    const prior = this.db
      .prepare(`SELECT id, state FROM posts WHERE idempotency_key = ?`)
      .get(input.key) as any;

    if (prior) {
      // Retries are allowed to reuse the row; a completed publish is not.
      return prior.state === 'published' ? null : prior.id;
    }

    const id = newId('post');
    const ts = this.now();
    this.db
      .prepare(
        `INSERT INTO posts (id, draft_variant_id, approval_id, platform, account_id, state,
                            scheduled_for, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'publishing', ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.variant.id,
        input.approval.id,
        input.variant.platform,
        input.accountId,
        input.scheduledFor || null,
        input.key,
        ts,
        ts,
      );
    return id;
  }

  private startRun(kind: string, providerId?: string, refId?: string, args?: unknown): string {
    const id = newId('run');
    this.db
      .prepare(
        `INSERT INTO runs (id, kind, provider_id, ref_id, state, args, started_at)
         VALUES (?,?,?,?, 'running', ?, ?)`,
      )
      .run(
        id,
        kind,
        providerId ?? null,
        refId ?? null,
        // Never store raw arguments: they carry cookies, tokens and whole
        // drafts. See src/core/audit.ts.
        args === undefined ? null : auditJson(args),
        this.now(),
      );
    return id;
  }

  /** Fill in arguments only known after the run started (the resolved variant). */
  private setRunArgs(id: string, args: unknown): void {
    this.db.prepare(`UPDATE runs SET args = ? WHERE id = ?`).run(auditJson(args), id);
  }

  private finishRun(id: string, state: 'ok' | 'error', detail?: string): void {
    this.db
      .prepare(`UPDATE runs SET state=?, detail=?, finished_at=? WHERE id=?`)
      // Provider errors quote their own argv and request URLs, which is exactly
      // where a token turns up in a log nobody audited.
      .run(state, detail === undefined ? null : redactText(detail).slice(0, 2000), this.now(), id);
  }
}

/** Source items are stored separately; keep only their ids inside the brief. */
function briefForStorage(brief: ContentBrief) {
  return { ...brief, sources: brief.sources.map((s) => s.id) };
}
