#!/usr/bin/env node
import { loadConfig } from './config';
import { open } from './core/db';
import { Pipeline } from './core/pipeline';
import { Scheduler } from './core/scheduler';
import { createServer } from './server/api';
import { buildEngagement, buildProviders } from './cli';
import { EngagementRunner } from './core/engagement';
import { OutreachRunner } from './core/outreach';
import { GoalStore } from './core/goals';
import { buildCollectors, localCollectors } from './core/metrics';
import { buildNotifiers, notifyAll } from './providers/notify';
import { CredentialStore } from './core/credentials';
import { generateBriefing } from './core/briefing';
import { replyToken } from './core/approval-reply';
import { wireReplyApproval } from './providers/telegram/approval-poller';
import { TelegramEngagement } from './providers/engagement/telegram';
import type { Approval } from './core/approval';

/**
 * The long-running process.
 *
 * Claude Code is an interactive session; it cannot hold a schedule open. So the
 * daemon owns time — polling sources, firing due publishes, retrying failures —
 * and spawns Claude only for the steps that need judgement.
 *
 * Nothing here bypasses the approval gate: the scheduler can queue work and can
 * execute what a human already approved, but it can never approve on their
 * behalf.
 */

interface DaemonSchedule {
  /** When to poll sources and compose. Default: 08:00 daily. */
  ingest?: string;
  /** When to publish approved-and-due items. Default: every 5 minutes. */
  publish?: string;
  /** Keyword monitoring sweep. Default: hourly. */
  monitor?: string;
  /** Daily intelligence briefing. Default: 07:30. */
  briefing?: string;
  /** Comment polling + reply drafting. Default: every 30 minutes. */
  engage?: string;
  /** Goal review sweep. Default: Mondays at 09:00. */
  goals?: string;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const db = open(config.dbFile);
  const providers = buildProviders(config);
  const pipeline = new Pipeline(db, providers);

  const schedule: DaemonSchedule = (config as any).schedule ?? {};
  const port = Number(process.env.MEDIABOT_PORT ?? (config as any).port ?? 7788);

  const server = createServer({
    db,
    // The console's approve button must settle both kinds of approval.
    onExecute: async () => {
      const published = await pipeline.executeDue();
      const engagementProviders = buildEngagement(config);
      if (!engagementProviders.length) return published;
      const replies = await new EngagementRunner(db, {
        providers: engagementProviders,
        locale: config.locale,
      }).sendApproved();
      return {
        published: [...published.published, ...replies.sent],
        failed: [...published.failed, ...replies.failed],
      };
    },
  });

  const scheduler = new Scheduler({
    onError: (job, err) => log(`job ${job} failed: ${message(err)}`, 'warn'),
  });

  // Notify config may hold `secret:<name>` references rather than raw tokens.
  const credentials = new CredentialStore({ home: config.home });
  const notifyConfig = config.notify ?? {};
  const notifiers = buildNotifiers({
    ...notifyConfig,
    ...(await credentials.resolveAll({
      webhookUrl: notifyConfig.webhookUrl,
      telegramBotToken: notifyConfig.telegramBotToken,
      telegramChatId: notifyConfig.telegramChatId,
    })),
  });
  const consoleUrl = `http://127.0.0.1:${port}`;

  /** Ping whoever is on duty. Never lets a failed ping break the caller. */
  const ping = async (title: string, body: string, token?: string) => {
    if (!notifiers.length) return;
    const res = await notifyAll(notifiers, {
      title,
      body,
      url: consoleUrl,
      ...(token ? { token } : {}),
    });
    for (const f of res.failed) log(`notify ${f.id} failed: ${f.error}`, 'warn');
  };

  /**
   * Push each queued item separately so it can be decided by replying.
   *
   * A single "3 条待审批" line cannot be answered — there is nothing to say yes
   * to. Past a small batch the individual pings become the noise that gets the
   * bot muted, so the tail is summarised and sent to the console instead.
   */
  const maxPerBatch = config.notify?.maxPerBatch ?? 5;
  const pingApprovals = async (heading: string, approvals: Approval[]) => {
    const pending = approvals.filter((a) => a.state === 'pending');
    if (!pending.length) return;

    for (const a of pending.slice(0, maxPerBatch)) {
      const p = a.payload as any;
      const platform = p?.platform ?? a.kind;
      const preview = String(p?.title ? `${p.title}\n${p.body ?? ''}` : (p?.body ?? '')).slice(0, 300);
      await ping(`${heading}｜${platform}`, `${preview}\n\n回复「批准」或「拒绝」即可`, replyToken(a.id));
    }
    if (pending.length > maxPerBatch) {
      await ping(heading, `还有 ${pending.length - maxPerBatch} 条待审，去控制台看`);
    }
  };

  const pingApprovalIds = async (heading: string, ids: string[]) => {
    const items = ids.map((id) => pipeline.queue.get(id)).filter((a): a is Approval => !!a);
    await pingApprovals(heading, items);
  };

  scheduler.add({
    name: 'ingest',
    cron: schedule.ingest ?? '0 8 * * *',
    run: async () => {
      const res = await pipeline.ingest();
      log(`ingest: ${res.stored} new of ${res.fetched}`);
      for (const e of res.errors) log(`  source ${e.providerId}: ${e.message}`, 'warn');
      if (res.stored === 0) return;

      const { variants } = await pipeline.compose({
        sources: res.items,
        targetPlatforms: config.targetPlatforms,
        locale: config.locale,
        ...(config.style ? { style: config.style } : {}),
        ...(config.goal ? { goal: config.goal } : {}),
      });
      const proposal = await pipeline.propose(variants);
      log(`queued ${proposal.approvals.length} for approval`);
      for (const s of proposal.skipped) log(`  skipped ${s.platform}: ${s.reason}`, 'warn');
      await pingApprovals('草稿待审批', proposal.approvals);
    },
  });

  scheduler.add({
    name: 'publish',
    // Approved items should not sit waiting; a short cadence keeps the gap
    // between "human said yes" and "it went out" small.
    cron: schedule.publish ?? '*/5 * * * *',
    run: async () => {
      const res = await pipeline.executeDue();
      if (res.published.length) log(`published ${res.published.length}`);
      for (const f of res.failed) {
        log(`publish failed ${f.approvalId}: ${f.error}${f.willRetry ? ' (will retry)' : ''}`, 'warn');
      }
    },
  });

  scheduler.add({
    name: 'monitor',
    // Read-only sweep: collects signals without composing or queueing anything.
    cron: schedule.monitor ?? '15 * * * *',
    run: async () => {
      const res = await pipeline.ingest({ keywords: config.keywords, limit: 30 });
      if (res.stored) log(`monitor: ${res.stored} new signals`);
      for (const e of res.errors) log(`  source ${e.providerId}: ${e.message}`, 'warn');
    },
  });

  scheduler.add({
    name: 'briefing',
    cron: schedule.briefing ?? '30 7 * * *',
    run: async () => {
      const b = await generateBriefing(db, { locale: config.locale });
      log(`briefing: ${b.itemCount} signals`);
      if (b.itemCount) {
        process.stdout.write(`\n${b.text}\n\n`);
        await ping('今日情报简报', b.text.slice(0, 500));
      }
    },
  });

  const engagement = buildEngagement(config);

  /**
   * Approving from the phone, by replying to the notification.
   *
   * Wiring is a decision rather than a switch because `getUpdates` is a
   * single-consumer stream: if the group-reply provider is configured it
   * already owns the stream and this attaches to it; only otherwise does a
   * poller start. Two consumers would silently steal each other's messages.
   */
  const telegramEngagement = engagement.find(
    (p): p is TelegramEngagement => p instanceof TelegramEngagement,
  );
  const replyWiring = wireReplyApproval({
    queue: pipeline.queue,
    config: {
      ...(notifyConfig.telegramOwnerId ? { ownerId: notifyConfig.telegramOwnerId } : {}),
      ...(config.telegram?.token ?? notifyConfig.telegramBotToken
        ? { token: (config.telegram?.token ?? notifyConfig.telegramBotToken)! }
        : {}),
    },
    ...(telegramEngagement ? { engagement: telegramEngagement } : {}),
    onOutcome: (outcome) => {
      if (outcome.status === 'decided') {
        log(`reply-approval: ${outcome.decision} ${outcome.approval.id}`);
        // Publish on the next `publish` tick rather than from inside a message
        // handler — executing here would run publishes on the poll's stack,
        // where a failure would take the poller down with it.
      } else if (outcome.status === 'unknown') {
        log(`reply-approval: no unique approval for [mb:${outcome.idFragment}]`, 'warn');
      }
    },
  });

  if (replyWiring.mode === 'polling') {
    scheduler.add({
      name: 'approvals',
      // Short: this is a human waiting for their reply to take effect.
      cron: '*/2 * * * *',
      run: async () => {
        const outcomes = await replyWiring.poller.poll();
        if (outcomes.some((o) => o.status === 'decided')) await pipeline.executeDue();
      },
    });
  }

  if (engagement.length) {
    const runner = new EngagementRunner(db, {
      providers: engagement,
      locale: config.locale,
      ...(config.style ? { style: config.style } : {}),
    });

    scheduler.add({
      name: 'engage',
      cron: schedule.engage ?? '*/30 * * * *',
      run: async () => {
        const polled = await runner.poll();
        if (polled.stored) log(`engage: ${polled.stored} new comments`);
        for (const e of polled.errors) log(`  ${e.platform}: ${e.message}`, 'warn');

        if (polled.stored) {
          const drafted = await runner.draftReplies();
          if (drafted.drafted) {
            log(`engage: ${drafted.drafted} replies awaiting approval`);
            await pingApprovalIds('回复待审批', drafted.queued);
          }
        }

        // Replies a human already approved go out on the same tick.
        const sent = await runner.sendApproved();
        if (sent.sent.length) log(`engage: ${sent.sent.length} replies sent`);
        for (const f of sent.failed) log(`  reply failed ${f.approvalId}: ${f.error}`, 'warn');
      },
    });
  }

  if (config.outreach?.enabled && engagement.length) {
    const outreach = new OutreachRunner(db, {
      providers: engagement,
      locale: config.locale,
      ...(config.style ? { style: config.style } : {}),
      ...(config.outreach.dailyLimits ? { dailyLimits: config.outreach.dailyLimits } : {}),
    });

    scheduler.add({
      name: 'outreach',
      // Hourly at most; the per-platform caps and randomised gaps do the real
      // rate limiting inside propose().
      cron: '45 * * * *',
      run: async () => {
        const targets = db
          .prepare(
            `SELECT id, provider_id, kind, title, url, summary, score
               FROM source_items
              WHERE kind = 'trend' AND fetched_at >= ?
              ORDER BY COALESCE(score, 0) DESC LIMIT 20`,
          )
          .all(Date.now() - 24 * 3600_000) as any[];

        const res = await outreach.propose(
          targets.map((t) => ({
            id: t.id,
            providerId: t.provider_id,
            kind: t.kind,
            title: t.title,
            ...(t.url ? { url: t.url } : {}),
            ...(t.summary ? { summary: t.summary } : {}),
          })),
          config.outreach?.perRun ?? 3,
        );
        if (res.queued.length) {
          log(`outreach: ${res.queued.length} comments awaiting approval`);
          await pingApprovalIds('引流评论待审批', res.queued);
        }
      },
    });
  }

  scheduler.add({
    name: 'goals',
    cron: schedule.goals ?? '0 9 * * 1',
    run: async () => {
      const store = new GoalStore(db, [...buildCollectors(), ...localCollectors(db)]);
      for (const goal of store.listActive()) {
        const check = await store.review(goal.id);
        const p = store.progress(goal.id);
        log(
          `goal ${goal.title}: ${check.measured ?? 'unavailable'}` +
            (p.progress === null ? '' : ` (${Math.round(p.progress * 100)}% of target)`),
        );
      }
    },
  });

  await new Promise<void>((resolve) => {
    // Loopback only — the database holds credentials and pending outbound posts.
    server.listen(port, '127.0.0.1', resolve);
  });

  log(`MediaBot daemon up`);
  log(`  console   http://127.0.0.1:${port}`);
  log(`  data      ${config.home}`);
  log(`  platforms ${config.targetPlatforms.join(', ') || '(none configured)'}`);
  log(`  jobs      ${scheduler.jobNames.join(', ')}`);
  log(`  notify    ${notifiers.map((n) => n.id).join(', ') || '(none configured)'}`);

  scheduler.start();
  // Evaluate immediately so a restart does not leave approved work stranded
  // until the next cron minute.
  await scheduler.tick();

  const shutdown = (sig: string) => {
    log(`${sig} received, shutting down`);
    scheduler.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function log(msg: string, level: 'info' | 'warn' = 'info'): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  (level === 'warn' ? process.stderr : process.stdout).write(line);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`daemon failed to start: ${message(err)}\n`);
    process.exit(1);
  });
}
