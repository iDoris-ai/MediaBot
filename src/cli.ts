#!/usr/bin/env node
import { loadConfig } from './config';
import { open } from './core/db';
import { Pipeline } from './core/pipeline';
import { ApprovalQueue } from './core/approval';
import { RssSourceProvider } from './providers/source/rss';
import { CliSearchSource, type SearchPlatform } from './providers/source/cli-search';
import { ClaudeComposer } from './providers/composer/claude';
import { DryRunPublisher } from './providers/publisher/dryrun';
import { XiaohongshuPublisher } from './providers/publisher/xiaohongshu';
import { TwitterPublisher } from './providers/publisher/twitter';
import { WeChatMpPublisher } from './providers/publisher/wechat-mp';
import { BilibiliPublisher } from './providers/publisher/bilibili';
import { XiaohongshuEngagement } from './providers/engagement/xiaohongshu';
import { TwitterEngagement } from './providers/engagement/twitter';
import type { PipelineProviders } from './core/pipeline';
import type { EngagementProvider, PublisherProvider } from './contracts';

/**
 * Developer/debug entry point. The Web UI is the primary interface; this exists
 * so the whole loop can be driven and inspected from a terminal.
 */

const USAGE = `mediabot — media operations agent

Usage:
  mediabot run [--dry] [--auto]   Ingest → compose → validate → queue for approval
  mediabot queue [state]          List approvals (default: pending)
  mediabot approve <id> [--now]   Approve a queued item, then publish if due
  mediabot reject <id> [reason]   Reject a queued item
  mediabot status                 Counts by table and recent runs
  mediabot providers              Configured providers and their health

Config: ~/.mediabot/config.json (override root with MEDIABOT_HOME)
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(USAGE);
    return 0;
  }

  const config = loadConfig();
  const db = open(config.dbFile);
  const providers = buildProviders(config);

  switch (command) {
    case 'run': {
      const pipeline = new Pipeline(db, providers);
      const dryRun = rest.includes('--dry');
      const autoApprove = rest.includes('--auto');

      const res = await pipeline.runOnce(
        {
          targetPlatforms: config.targetPlatforms,
          locale: config.locale,
          ...(config.style ? { style: config.style } : {}),
          ...(config.goal ? { goal: config.goal } : {}),
        },
        { autoApprove, dryRun },
      );

      log(`ingested ${res.ingest.stored} new of ${res.ingest.fetched} fetched`);
      for (const e of res.ingest.errors) log(`  source ${e.providerId} failed: ${e.message}`, 'warn');
      log(`queued ${res.propose.approvals.length} for approval`);
      for (const s of res.propose.skipped) log(`  skipped ${s.platform}: ${s.reason}`, 'warn');
      if (res.execute) {
        log(`published ${res.execute.published.length}`);
        for (const f of res.execute.failed) {
          log(`  failed ${f.approvalId}: ${f.error}${f.willRetry ? ' (will retry)' : ''}`, 'warn');
        }
      } else if (res.propose.approvals.length) {
        log(`review with: mediabot queue`);
      }
      return res.ingest.errors.length ? 1 : 0;
    }

    case 'queue': {
      const q = new ApprovalQueue(db);
      const state = (rest[0] as any) ?? 'pending';
      const items = q.list(state);
      if (!items.length) {
        log(`no ${state} approvals`);
        return 0;
      }
      for (const a of items) {
        const p = a.payload as any;
        const when = a.scheduledFor ? new Date(a.scheduledFor).toISOString() : 'asap';
        log(`${a.id}  ${a.kind}  ${p?.platform ?? '-'}  ${when}`);
        log(`    ${preview(p?.title ? `${p.title} — ${p.body}` : p?.body ?? '')}`);
      }
      return 0;
    }

    case 'approve': {
      const id = rest[0];
      if (!id) return fail('approve needs an approval id');
      const pipeline = new Pipeline(db, providers);
      pipeline.queue.approve(id, { by: 'cli' });
      log(`approved ${id}`);

      const exec = await pipeline.executeDue();
      for (const p of exec.published) log(`published ${p.postId}${p.url ? ` → ${p.url}` : ''}`);
      for (const f of exec.failed) log(`failed ${f.approvalId}: ${f.error}`, 'warn');
      return exec.failed.length ? 1 : 0;
    }

    case 'reject': {
      const id = rest[0];
      if (!id) return fail('reject needs an approval id');
      new ApprovalQueue(db).reject(id, { by: 'cli', ...(rest[1] ? { reason: rest.slice(1).join(' ') } : {}) });
      log(`rejected ${id}`);
      return 0;
    }

    case 'status': {
      for (const t of ['source_items', 'drafts', 'draft_variants', 'approvals', 'posts', 'comments']) {
        const c = (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as any).c;
        log(`${t.padEnd(16)} ${c}`);
      }
      const pending = (db.prepare(`SELECT COUNT(*) c FROM approvals WHERE state='pending'`).get() as any).c;
      if (pending) log(`\n${pending} awaiting approval — mediabot queue`);

      const runs = db.prepare(`SELECT kind, state, detail, started_at FROM runs ORDER BY started_at DESC LIMIT 5`).all() as any[];
      if (runs.length) {
        log('\nrecent runs:');
        for (const r of runs) {
          log(`  ${new Date(r.started_at).toISOString()}  ${r.kind.padEnd(12)} ${r.state}  ${r.detail ?? ''}`);
        }
      }
      return 0;
    }

    case 'providers': {
      for (const s of providers.sources ?? []) {
        const h = await s.healthCheck();
        log(`source     ${s.info.id.padEnd(20)} ${h.ok ? 'ok' : `FAIL ${h.detail ?? ''}`}`);
      }
      if (providers.composer) {
        const h = await providers.composer.healthCheck();
        log(`composer   ${providers.composer.info.id.padEnd(20)} ${h.ok ? 'ok' : `FAIL ${h.detail ?? ''}`}`);
      }
      for (const p of providers.publishers ?? []) {
        const a = await p.checkAuth();
        log(`publisher  ${p.platform.padEnd(20)} ${p.transport}  ${a.ok ? 'ok' : `FAIL ${a.reason ?? ''}`}`);
      }
      return 0;
    }

    default:
      return fail(`unknown command: ${command}\n\n${USAGE}`);
  }
}

/**
 * Platforms with a real publisher. Anything else falls back to the dry-run
 * publisher, so an unconfigured platform writes to disk rather than failing —
 * you can always see what *would* have shipped.
 */
const REAL_PUBLISHERS: Record<string, () => PublisherProvider> = {
  xiaohongshu: () => new XiaohongshuPublisher(),
  twitter: () => new TwitterPublisher(),
  'wechat-mp': () => new WeChatMpPublisher(),
  bilibili: () => new BilibiliPublisher(),
};

export const REAL_ENGAGEMENT: Record<string, () => EngagementProvider> = {
  xiaohongshu: () => new XiaohongshuEngagement(),
  twitter: () => new TwitterEngagement(),
};

export function buildProviders(config: ReturnType<typeof loadConfig>): PipelineProviders {
  return {
    sources: [
      ...(config.feeds.length ? [new RssSourceProvider({ feeds: config.feeds })] : []),
      ...config.searchPlatforms.map(
        (p) => new CliSearchSource(p as SearchPlatform, { keywords: config.keywords }),
      ),
    ],
    composer: new ClaudeComposer(),
    publishers: config.targetPlatforms.map((platform) => {
      const real = REAL_PUBLISHERS[platform];
      return real ? real() : new DryRunPublisher({ platform, outDir: config.outDir });
    }),
  };
}

function preview(s: string, n = 100): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

function log(msg: string, level: 'info' | 'warn' = 'info'): void {
  (level === 'warn' ? process.stderr : process.stdout).write(`${msg}\n`);
}

function fail(msg: string): number {
  process.stderr.write(`${msg}\n`);
  return 1;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}

export { main };
