import type { SourceItem } from '../contracts';
import type { Db } from './db';
import { newId } from './identity';
import { runClaude, type ClaudeOptions } from './claude';

/**
 * The daily intelligence briefing.
 *
 * Summarises what monitoring found and stops there. A briefing is read-only by
 * construction: it produces text for a human to read, never a draft and never
 * an approval. Turning a trend into a post stays an explicit human decision —
 * that boundary is what keeps "monitoring" from quietly becoming "autoposting".
 */

export interface BriefingOptions {
  /** How far back to include items. */
  sinceMs?: number;
  maxItems?: number;
  locale?: string;
  runner?: (prompt: string, opts?: ClaudeOptions) => Promise<{ text: string; transcript: string }>;
  now?: () => number;
}

export interface Briefing {
  id: string;
  generatedAt: number;
  itemCount: number;
  /** Model-written summary, or a plain listing if the model is unavailable. */
  text: string;
  items: BriefingItem[];
}

export interface BriefingItem {
  id: string;
  providerId: string;
  title: string;
  url?: string;
  score?: number;
}

export async function generateBriefing(db: Db, opts: BriefingOptions = {}): Promise<Briefing> {
  const now = opts.now ?? Date.now;
  const since = now() - (opts.sinceMs ?? 24 * 60 * 60_000);
  const max = opts.maxItems ?? 30;

  const rows = db
    .prepare(
      `SELECT id, provider_id, kind, title, url, summary, score, published_at, fetched_at
         FROM source_items
        WHERE COALESCE(published_at, fetched_at) >= ?
        ORDER BY COALESCE(score, 0) DESC, COALESCE(published_at, fetched_at) DESC
        LIMIT ?`,
    )
    .all(since, max) as any[];

  const items: BriefingItem[] = rows.map((r) => ({
    id: r.id,
    providerId: r.provider_id,
    title: r.title,
    ...(r.url ? { url: r.url } : {}),
    ...(r.score !== null ? { score: r.score } : {}),
  }));

  const id = newId('brief');
  const generatedAt = now();

  if (items.length === 0) {
    return { id, generatedAt, itemCount: 0, text: '过去 24 小时没有新的监控信号。', items };
  }

  const runner = opts.runner ?? ((p, o) => runClaude(p, o));
  let text: string;
  try {
    const res = await runner(buildBriefingPrompt(rows, opts.locale ?? 'zh-CN'));
    text = (res.text || res.transcript).trim();
    if (!text) text = plainListing(items);
  } catch {
    // A briefing is informational; if the model is down, still show the raw
    // findings rather than losing the poll entirely.
    text = plainListing(items);
  }

  const runId = newId('run');
  db.prepare(
    `INSERT INTO runs (id, kind, state, detail, started_at, finished_at) VALUES (?, 'briefing', 'ok', ?, ?, ?)`,
  ).run(runId, `${items.length} items`, generatedAt, now());

  return { id, generatedAt, itemCount: items.length, text, items };
}

export function buildBriefingPrompt(rows: any[], locale: string): string {
  const lines = rows.map((r, i) => {
    const bits = [`${i + 1}. [${r.provider_id}] ${r.title}`];
    if (r.score) bits.push(`   热度: ${r.score}`);
    if (r.url) bits.push(`   ${r.url}`);
    if (r.summary) bits.push(`   ${String(r.summary).slice(0, 200)}`);
    return bits.join('\n');
  });

  return [
    `你是内容运营的情报分析员。下面是过去 24 小时监控到的信号，用 ${locale} 写一份简报。`,
    '',
    '要求：',
    '- 先给 3-5 条关键判断（哪些值得关注、为什么）',
    '- 再按主题归类，指出重复出现的话题',
    '- 最后列出「可能值得写」的选题，但不要写文案本身',
    '- 不要建议自动发布任何内容',
    '',
    '监控信号：',
    ...lines,
  ].join('\n');
}

function plainListing(items: BriefingItem[]): string {
  return [
    `监控到 ${items.length} 条信号（模型不可用，以下为原始列表）：`,
    '',
    ...items.map((i, n) => `${n + 1}. [${i.providerId}] ${i.title}${i.url ? `\n   ${i.url}` : ''}`),
  ].join('\n');
}
