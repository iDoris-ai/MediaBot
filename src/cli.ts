#!/usr/bin/env node
import fs from 'fs';
import { loadConfig } from './config';
import { open } from './core/db';
import { Pipeline } from './core/pipeline';
import { ApprovalQueue } from './core/approval';
import { consequenceOf, isGrantable } from './core/consequence';
import { GoalStore } from './core/goals';
import { CredentialStore } from './core/credentials';
import { buildCollectors, localCollectors } from './core/metrics';
import { RssSourceProvider } from './providers/source/rss';
import { CliSearchSource, type SearchPlatform } from './providers/source/cli-search';
import { McpSource } from './providers/source/mcp';
import { RedditSource } from './providers/source/reddit';
import { ClaudeComposer } from './providers/composer/claude';
import { FluxImageComposer } from './providers/composer/flux-image';
import { TtsComposer } from './providers/composer/tts';
import { VideoComposer } from './providers/composer/video';
import { ChainComposer } from './providers/composer/chain';
import { DryRunPublisher } from './providers/publisher/dryrun';
import { XiaohongshuPublisher } from './providers/publisher/xiaohongshu';
import { TwitterPublisher } from './providers/publisher/twitter';
import { WeChatMpPublisher } from './providers/publisher/wechat-mp';
import { BilibiliPublisher } from './providers/publisher/bilibili';
import { BLOG_SCHEMAS, BlogPublisher } from './providers/publisher/blog';
import { TelegramPublisher } from './providers/publisher/telegram';
import { TelegramEngagement } from './providers/engagement/telegram';
import { RedditEngagement } from './providers/engagement/reddit';
import {
  BrowserPublisher,
  UPLOAD_PROFILE_TEMPLATES,
  missingSelectors,
  type UploadProfile,
} from './providers/publisher/browser-publisher';
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
  mediabot rules                  Standing approvals, and what may be granted
  mediabot allow <action> <target>  Stop asking for this exact destination
  mediabot revoke "<entry>"       Withdraw a standing approval
  mediabot status                 Counts by table and recent runs
  mediabot goals                  List goals and progress
  mediabot goal new <metric> <target> <title>
  mediabot goal measure <id>      Measure the baseline
  mediabot goal start <id>        Activate (needs a measured baseline)
  mediabot goal review <id>       Take a reading and score the last forecast
  mediabot metrics                Show every collectable metric
  mediabot secret set <name>      Store a secret (reads stdin), prints its reference
  mediabot secret rm <name>       Remove a stored secret
  mediabot secret backend         Which backend is in use
  mediabot profiles               Browser upload profiles and what they still need
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
        if (a.decidedBy?.startsWith('rule:')) {
          log(`    approved by ${a.decidedBy.slice('rule:'.length)}`);
        } else if (a.grantEntry && a.state === 'pending') {
          // Only shown for actions that could be granted at all; an
          // irreversible platform never advertises an option it will refuse.
          log(`    stop asking: mediabot allow ${a.grantEntry}`);
        }
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

    case 'allow': {
      const [action, ...targetParts] = rest;
      const target = targetParts.join(' ');
      if (!action || !target) {
        return fail('usage: mediabot allow <action> <target>   (copy the line from `mediabot queue`)');
      }

      // The consequence comes from the live provider, never from the command
      // line — otherwise anyone could grant an irreversible platform by
      // claiming it was reversible.
      const platform = action.split(':')[1] ?? '';
      const publisher = (providers.publishers ?? []).find((p) => p.platform === platform);
      if (!publisher) return fail(`no publisher configured for "${platform}"`);

      const declared = publisher.targetFor?.();
      if (declared !== undefined && declared !== target) {
        return fail(
          `"${target}" is not where ${platform} currently publishes (${declared ?? 'no target'}) — ` +
            `a rule must name the exact destination`,
        );
      }

      try {
        const rule = new ApprovalQueue(db).standingRules.grant(
          { action, target, consequence: consequenceOf(publisher) },
          'cli',
        );
        log(`granted: ${rule.entry}  (${rule.consequence})`);
        log(`revoke with: mediabot revoke "${rule.entry}"`);
        return 0;
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }

    case 'rules': {
      const rules = new ApprovalQueue(db).standingRules.list();
      if (rules.length) {
        log('standing rules (auto-approved):');
        for (const r of rules) {
          log(`  ${r.entry}`);
          log(`    ${r.consequence}, granted by ${r.createdBy ?? 'unknown'} on ${new Date(r.createdAt).toISOString()}`);
        }
      } else {
        log('no standing rules — every outbound action asks');
      }

      log('');
      log('grantable actions from the current config:');
      let any = false;
      for (const p of providers.publishers ?? []) {
        const consequence = consequenceOf(p);
        const target = p.targetFor?.();
        if (!isGrantable(consequence) || !target) {
          log(`  publish:${p.platform.padEnd(18)} — never (${consequence})`);
          continue;
        }
        any = true;
        log(`  publish:${p.platform.padEnd(18)} ${target}   (${consequence})`);
      }
      if (!any) log('  (none — nothing configured can be pre-approved)');
      return 0;
    }

    case 'revoke': {
      const entry = rest.join(' ');
      if (!entry) return fail('usage: mediabot revoke "<action> <target>"');
      const removed = new ApprovalQueue(db).standingRules.revoke(entry);
      log(removed ? `revoked: ${entry}` : `no such rule: ${entry}`);
      return removed ? 0 : 1;
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

    case 'profiles': {
      const overrides = (config.browserProfiles ?? {}) as Record<string, Partial<UploadProfile>>;
      for (const [name, tpl] of Object.entries(UPLOAD_PROFILE_TEMPLATES)) {
        const merged = { ...tpl, ...(overrides[name] ?? {}) } as UploadProfile;
        const missing = missingSelectors(merged);
        log(`${name.padEnd(18)} ${merged.verified ? 'verified' : 'UNVERIFIED'}`);
        log(`    upload: ${merged.uploadUrl}`);
        if (missing.length) {
          log(`    missing selectors: ${missing.join(', ')}`);
          log(`    fill them in config.browserProfiles.${name}, then set "verified": true`);
        } else if (!merged.verified) {
          // Distinct from missing: the selectors are present but unproven, and
          // saying "fill them in" would send the user looking for nothing.
          log(`    selectors present but unproven — open the page above, confirm each one,`);
          log(`    then set config.browserProfiles.${name}.verified = true`);
        }
      }
      return 0;
    }

    case 'secret': {
      const store = new CredentialStore({ home: config.home });
      const [sub, name] = rest;

      if (sub === 'backend') {
        log(store.backendName);
        return 0;
      }
      if (sub === 'set') {
        if (!name) return fail('usage: mediabot secret set <name>   (value is read from stdin)');
        const value = fs.readFileSync(0, 'utf8').trim();
        if (!value) return fail('no value on stdin');
        const ref = await store.set(name, value);
        log(`stored via ${store.backendName}`);
        log(`put this in config.json instead of the secret: "${ref}"`);
        return 0;
      }
      if (sub === 'rm') {
        if (!name) return fail('usage: mediabot secret rm <name>');
        await store.remove(name);
        log(`removed ${name}`);
        return 0;
      }
      return fail(`unknown secret subcommand: ${sub ?? '(none)'}`);
    }

    case 'metrics': {
      const collectors = [...buildCollectors(), ...localCollectors(db)];
      for (const c of collectors) {
        const r = await c.collect();
        log(
          `${c.metric.padEnd(24)} ${r.value === null ? `unavailable — ${r.unavailable}` : r.value}`,
        );
      }
      return 0;
    }

    case 'goals': {
      const goals = new GoalStore(db, [...buildCollectors(), ...localCollectors(db)]);
      const all = goals.list();
      if (!all.length) {
        log('no goals — mediabot goal new <metric> <target> <title>');
        return 0;
      }
      for (const g of all) {
        const p = goals.progress(g.id);
        const pct = p.progress === null ? '—' : `${Math.round(p.progress * 100)}%`;
        log(`${g.id}  ${g.state.padEnd(7)} ${g.metric.padEnd(22)} ${pct.padStart(5)}  ${g.title}`);
        log(`    baseline ${g.baseline ?? '—'} → target ${g.target ?? '—'}  latest ${p.latest ?? '—'}`);
        if (p.lastPredictionError !== null) {
          log(`    last forecast was off by ${(p.lastPredictionError * 100).toFixed(1)}%`);
        }
      }
      return 0;
    }

    case 'goal': {
      const goals = new GoalStore(db, [...buildCollectors(), ...localCollectors(db)]);
      const [sub, ...args] = rest;

      if (sub === 'new') {
        const [metric, target, ...title] = args;
        if (!metric || !target) return fail('usage: mediabot goal new <metric> <target> <title>');
        const g = goals.propose({
          title: title.join(' ') || metric,
          metric,
          target: Number(target),
        });
        log(`${g.id} created (draft) — measure the baseline: mediabot goal measure ${g.id}`);
        return 0;
      }
      if (sub === 'measure') {
        if (!args[0]) return fail('usage: mediabot goal measure <id>');
        const res = await goals.measureBaseline(args[0]);
        if (res.error) return fail(`cannot measure: ${res.error}`);
        log(`baseline ${res.goal.baseline} measured — activate: mediabot goal start ${res.goal.id}`);
        return 0;
      }
      if (sub === 'start') {
        if (!args[0]) return fail('usage: mediabot goal start <id>');
        log(`${goals.activate(args[0]).id} active`);
        return 0;
      }
      if (sub === 'review') {
        if (!args[0]) return fail('usage: mediabot goal review <id>');
        const c = await goals.review(args[0]);
        log(`measured ${c.measured ?? `unavailable (${c.note})`}`);
        return 0;
      }
      return fail(`unknown goal subcommand: ${sub ?? '(none)'}`);
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
  reddit: () => new RedditEngagement(),
};

/**
 * Telegram needs config (token + chat), so it is built separately from the
 * zero-config providers above. Secrets are resolved by the caller.
 */
export function buildTelegram(
  cfg: NonNullable<ReturnType<typeof loadConfig>['telegram']>,
): { publisher: PublisherProvider; engagement: EngagementProvider } {
  return {
    publisher: new TelegramPublisher({ token: cfg.token, chatId: cfg.chatId }),
    engagement: new TelegramEngagement({
      token: cfg.token,
      chatIds: cfg.watchChatIds ?? [cfg.chatId],
      trigger: {
        ...(cfg.keywords ? { keywords: cfg.keywords } : {}),
        ...(cfg.respondToCommands !== undefined ? { respondToCommands: cfg.respondToCommands } : {}),
      },
    }),
  };
}

/** Engagement providers for the platforms currently targeted. */
export function buildEngagement(config: ReturnType<typeof loadConfig>): EngagementProvider[] {
  const out = config.targetPlatforms
    .map((p) => REAL_ENGAGEMENT[p])
    .filter((f): f is () => EngagementProvider => Boolean(f))
    .map((f) => f());
  if (config.targetPlatforms.includes('telegram') && config.telegram) {
    out.push(buildTelegram(config.telegram).engagement);
  }
  return out;
}

/** Browser publishers, built only from profiles the user marked verified. */
export function buildBrowserPublishers(
  config: ReturnType<typeof loadConfig>,
): Record<string, () => PublisherProvider> {
  const overrides = (config.browserProfiles ?? {}) as Record<string, Partial<UploadProfile>>;
  const out: Record<string, () => PublisherProvider> = {};

  for (const [name, tpl] of Object.entries(UPLOAD_PROFILE_TEMPLATES)) {
    const profile = { ...tpl, ...(overrides[name] ?? {}) } as UploadProfile;
    out[name] = () => new BrowserPublisher({ profile });
  }
  return out;
}

/** Text composer, optionally preceded by local asset generators. */
export function buildComposer(config: ReturnType<typeof loadConfig>) {
  // Order matters: the video composer consumes what the image and audio
  // composers produced, so it must run last.
  const assetProviders = [
    ...(config.generateImages ? [new FluxImageComposer()] : []),
    ...(config.generateVoiceover
      ? [new TtsComposer(config.voice ? { voice: config.voice } : {})]
      : []),
    ...(config.generateVideo ? [new VideoComposer()] : []),
  ];
  return assetProviders.length
    ? new ChainComposer({ assetProviders, textComposer: new ClaudeComposer() })
    : new ClaudeComposer();
}

/** Blog publishers, one per configured target. */
export function buildBlogPublishers(
  config: ReturnType<typeof loadConfig>,
): Record<string, () => PublisherProvider> {
  const out: Record<string, () => PublisherProvider> = {};
  for (const [platform, cfg] of Object.entries(config.blogs ?? {})) {
    out[platform] = () =>
      new BlogPublisher({
        platform,
        repo: cfg.repo,
        contentDir: cfg.contentDir,
        schema: BLOG_SCHEMAS[cfg.schema ?? 'blog']!,
        ...(cfg.urlPattern ? { urlPattern: cfg.urlPattern } : {}),
        ...(cfg.commit !== undefined ? { commit: cfg.commit } : {}),
        ...(cfg.push !== undefined ? { push: cfg.push } : {}),
      });
  }
  return out;
}

export function buildProviders(config: ReturnType<typeof loadConfig>): PipelineProviders {
  return {
    sources: [
      ...(config.feeds.length ? [new RssSourceProvider({ feeds: config.feeds })] : []),
      ...config.searchPlatforms.map(
        (p) => new CliSearchSource(p as SearchPlatform, { keywords: config.keywords }),
      ),
      ...(config.reddit
        ? [
            new RedditSource({
              keywords: config.keywords,
              ...(config.reddit.subreddits ? { subreddits: config.reddit.subreddits } : {}),
              ...(config.reddit.sort ? { sort: config.reddit.sort as any } : {}),
              ...(config.reddit.time ? { time: config.reddit.time as any } : {}),
            }),
          ]
        : []),
      ...config.mcpSources.map(
        (m) =>
          new McpSource({
            id: m.id,
            ...(m.name ? { name: m.name } : {}),
            ...(m.kind ? { kind: m.kind } : {}),
            server: {
              command: m.command,
              ...(m.args ? { args: m.args } : {}),
              ...(m.env ? { env: m.env } : {}),
            },
            tool: m.tool,
            keywords: config.keywords,
          }),
      ),
    ],
    composer: buildComposer(config),
    publishers: config.targetPlatforms.map((platform) => {
      if (platform === 'telegram' && config.telegram) return buildTelegram(config.telegram).publisher;
      const real =
        REAL_PUBLISHERS[platform] ??
        buildBlogPublishers(config)[platform] ??
        buildBrowserPublishers(config)[platform];
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
