#!/usr/bin/env node
/**
 * Acceptance drill.
 *
 * Runs the whole pipeline for real — real Claude, real local image and video
 * generation, real database — and reports evidence against the criteria in
 * docs/acceptance.md. Nothing is published: every publisher runs dry, so the
 * drill is safe to repeat.
 *
 * Some criteria cannot be settled by one run and are reported as such rather
 * than quietly marked green. "Daily time under 30 minutes" and "no rate limits
 * or bans" are claims about weeks of real use; asserting them from a single
 * scripted run would be dishonest.
 *
 *   pnpm drill
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { open } from '../src/core/db';
import { Pipeline } from '../src/core/pipeline';
import { ApprovalQueue } from '../src/core/approval';
import { ClaudeComposer } from '../src/providers/composer/claude';
import { ChainComposer } from '../src/providers/composer/chain';
import { FluxImageComposer } from '../src/providers/composer/flux-image';
import { TtsComposer } from '../src/providers/composer/tts';
import { VideoComposer } from '../src/providers/composer/video';
import { DryRunPublisher } from '../src/providers/publisher/dryrun';
import { XHS_LIMITS } from '../src/providers/publisher/xiaohongshu';
import { TWITTER_LIMITS } from '../src/providers/publisher/twitter';
import { WECHAT_MP_LIMITS } from '../src/providers/publisher/wechat-mp';
import { similarity } from '../src/core/platform-shapes';
import type { PlatformLimits } from '../src/contracts';

/**
 * Each platform's real limits, so validation in the drill means what it means
 * in production. Using the dry-run publisher's generic defaults would reject a
 * perfectly valid 7000-character blog post and quietly understate coverage.
 */
const DRILL_LIMITS: Record<string, PlatformLimits> = {
  xiaohongshu: XHS_LIMITS,
  twitter: TWITTER_LIMITS,
  'wechat-mp': WECHAT_MP_LIMITS,
  'blog-tech': { maxTextLength: 200_000, maxTitleLength: 200, supportsScheduling: false },
  reddit: { maxTextLength: 40_000, supportsScheduling: false },
};

const PLATFORMS = ['xiaohongshu', 'wechat-mp', 'blog-tech', 'twitter', 'reddit'];
const GOAL = '在自己的 Mac 上跑本地大模型，数据不出本机';

interface Finding {
  criterion: string;
  verdict: 'pass' | 'fail' | 'needs-real-use';
  evidence: string[];
}

async function main(): Promise<number> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mediabot-drill-'));
  const outDir = path.join(home, 'out');
  const media = path.join(home, 'media');
  const db = open(path.join(home, 'drill.db'));

  const withMedia = process.argv.includes('--media');
  log(`workspace: ${home}`);
  log(`media generation: ${withMedia ? 'on (slow — FLUX + TTS + ffmpeg)' : 'off (pass --media to include)'}`);

  const composer = withMedia
    ? new ChainComposer({
        assetProviders: [
          new FluxImageComposer({ outDir: media }),
          new TtsComposer({ outDir: media }),
          new VideoComposer({ outDir: media }),
        ],
        textComposer: new ClaudeComposer(),
        onAssetError: (id, err) => log(`  asset ${id} failed: ${String(err).slice(0, 80)}`, 'warn'),
      })
    : new ClaudeComposer();

  const pipeline = new Pipeline(db, {
    composer,
    publishers: PLATFORMS.map(
      (platform) =>
        new DryRunPublisher({
          platform,
          outDir,
          ...(DRILL_LIMITS[platform] ? { limits: DRILL_LIMITS[platform] } : {}),
        }),
    ),
  });

  const findings: Finding[] = [];

  // --- compose ------------------------------------------------------------
  log('\n[1/4] composing across ' + PLATFORMS.length + ' platforms…');
  const started = Date.now();
  const { variants } = await pipeline.compose({
    sources: [],
    targetPlatforms: PLATFORMS,
    locale: 'zh-CN',
    goal: GOAL,
  });
  const composeSeconds = Math.round((Date.now() - started) / 1000);
  log(`      ${variants.length} variants in ${composeSeconds}s`);

  for (const v of variants) {
    log(`      ${v.platform.padEnd(14)} ${String(v.body.length).padStart(5)} chars  ${preview(v.body)}`);
  }

  // Criterion 1: variants must not be copies of each other.
  const pairs: string[] = [];
  let worst = 0;
  for (let i = 0; i < variants.length; i += 1) {
    for (let j = i + 1; j < variants.length; j += 1) {
      const score = similarity(variants[i]!.body, variants[j]!.body);
      worst = Math.max(worst, score);
      pairs.push(`${variants[i]!.platform} × ${variants[j]!.platform}: ${score.toFixed(3)}`);
    }
  }
  const lengths = variants.map((v) => v.body.length);
  findings.push({
    criterion: '一条内容，多平台形态正确（不是复制粘贴）',
    verdict: worst < 0.75 && variants.length === PLATFORMS.length ? 'pass' : 'fail',
    evidence: [
      `${variants.length}/${PLATFORMS.length} platforms produced a variant`,
      `highest pairwise similarity ${worst.toFixed(3)} (threshold 0.75)`,
      `lengths ranged ${Math.min(...lengths)}–${Math.max(...lengths)} chars`,
      ...pairs,
    ],
  });

  // --- approval gate ------------------------------------------------------
  log('\n[2/4] validating and queueing for approval…');
  const proposal = await pipeline.propose(variants);
  log(`      ${proposal.approvals.length} queued, ${proposal.skipped.length} skipped`);
  for (const s of proposal.skipped) log(`      skipped ${s.platform}: ${s.reason}`);

  // Nothing may publish before a human approves.
  const beforeApproval = await pipeline.executeDue();
  const publishedWithoutApproval = beforeApproval.published.length;

  // --- publish ------------------------------------------------------------
  log('\n[3/4] approving and publishing (dry run)…');
  const queue = new ApprovalQueue(db);
  for (const a of proposal.approvals) queue.approve(a.id, { by: 'drill' });

  const first = await pipeline.executeDue({ dryRun: true });
  const second = await pipeline.executeDue({ dryRun: true });
  log(`      first pass published ${first.published.length}, replay published ${second.published.length}`);

  // --- tamper check -------------------------------------------------------
  log('\n[4/4] checking the approval gate holds under tampering…');
  const tamperVariant = variants[0]!;
  const tamperApproval = queue.enqueue({
    kind: 'publish',
    refId: tamperVariant.id,
    payload: tamperVariant,
  });
  queue.approve(tamperApproval.id);
  db.prepare(`UPDATE approvals SET payload = ? WHERE id = ?`).run(
    JSON.stringify({ ...tamperVariant, body: 'INJECTED CONTENT' }),
    tamperApproval.id,
  );
  const afterTamper = await pipeline.executeDue({ dryRun: true });
  const tamperBlocked = afterTamper.published.length === 0;
  log(`      tampered payload ${tamperBlocked ? 'BLOCKED' : 'PUBLISHED — this is a defect'}`);

  findings.push({
    criterion: '各平台校验通过率（用真实平台限制）',
    verdict: proposal.approvals.length === variants.length ? 'pass' : 'fail',
    evidence: [
      `${proposal.approvals.length}/${variants.length} variants passed their platform's real limits`,
      ...proposal.skipped.map((s) => `skipped ${s.platform}: ${s.reason}`),
    ],
  });

  findings.push({
    criterion: '不出事故（无误发、无重复发、无未批准即发）',
    verdict:
      publishedWithoutApproval === 0 && second.published.length === 0 && tamperBlocked ? 'pass' : 'fail',
    evidence: [
      `published before approval: ${publishedWithoutApproval} (must be 0)`,
      `published on replay: ${second.published.length} (must be 0 — idempotency key)`,
      `payload tampered after approval: ${tamperBlocked ? 'refused and re-queued' : 'PUBLISHED'}`,
      `artifacts written to ${outDir}`,
    ],
  });

  // --- criteria that a single run cannot settle ---------------------------
  findings.push({
    criterion: '回复质量能看（抽 10 条自动起草的回复，可直发 ≥ 7 条）',
    verdict: 'needs-real-use',
    evidence: [
      'requires real comments on real published posts to judge',
      'the drafting path and its approval gate are covered by tests, but quality is a human call',
    ],
  });
  findings.push({
    criterion: '每天投入 ≤ 30 分钟，且全花在审阅上',
    verdict: 'needs-real-use',
    evidence: [
      `this run: ${composeSeconds}s of machine time to produce ${variants.length} platform-ready drafts`,
      'the human cost is reviewing them; measurable only over real days',
    ],
  });
  findings.push({
    criterion: '平台账号安全（不因自动化被限流或封号）',
    verdict: 'needs-real-use',
    evidence: [
      'rate caps, randomised gaps and per-platform daily limits are enforced and tested',
      'whether they are conservative enough is only answerable after weeks of live use',
    ],
  });

  // --- report -------------------------------------------------------------
  const report = renderReport(findings, { home, outDir, withMedia });
  const reportPath = path.join(home, 'acceptance-report.md');
  fs.writeFileSync(reportPath, report);

  process.stdout.write(`\n${report}\n`);
  log(`report written to ${reportPath}`);

  const failed = findings.filter((f) => f.verdict === 'fail');
  return failed.length ? 1 : 0;
}

function renderReport(
  findings: Finding[],
  ctx: { home: string; outDir: string; withMedia: boolean },
): string {
  const mark = { pass: '✅', fail: '❌', 'needs-real-use': '⏳' } as const;
  const lines = [
    '# MediaBot 验收演练报告',
    '',
    `生成于 ${new Date().toISOString()}`,
    `媒体生成: ${ctx.withMedia ? '开启' : '关闭'} · 产物: ${ctx.outDir}`,
    '',
    '对照 docs/acceptance.md §四 的五条标准。**全程 dry-run，未向任何平台发布。**',
    '',
  ];

  for (const f of findings) {
    lines.push(`## ${mark[f.verdict]} ${f.criterion}`, '');
    for (const e of f.evidence) lines.push(`- ${e}`);
    lines.push('');
  }

  const pending = findings.filter((f) => f.verdict === 'needs-real-use').length;
  if (pending) {
    lines.push(
      '---',
      '',
      `⏳ 有 ${pending} 条标准无法由一次脚本运行判定——它们是关于数周真实使用的主张。` +
        '把它们标成通过只是自欺。',
      '',
    );
  }
  return lines.join('\n');
}

function preview(s: string, n = 40): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

function log(msg: string, level: 'info' | 'warn' = 'info'): void {
  (level === 'warn' ? process.stderr : process.stdout).write(`${msg}\n`);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`drill failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
