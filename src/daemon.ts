#!/usr/bin/env node
import { loadConfig } from './config';
import { open } from './core/db';
import { Pipeline } from './core/pipeline';
import { Scheduler } from './core/scheduler';
import { createServer } from './server/api';
import { buildProviders } from './cli';
import { generateBriefing } from './core/briefing';

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
    onExecute: () => pipeline.executeDue(),
  });

  const scheduler = new Scheduler({
    onError: (job, err) => log(`job ${job} failed: ${message(err)}`, 'warn'),
  });

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
      if (b.itemCount) process.stdout.write(`\n${b.text}\n\n`);
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
