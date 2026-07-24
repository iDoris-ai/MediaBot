import type {
  ProviderInfo,
  SourceItem,
  SourceKind,
  SourceProvider,
  SourceQuery,
} from '../../contracts';
import { ProviderError } from '../../contracts';
import { defaultCliRunner, runJsonCli, type CliRunner } from '../../core/cli-adapter';

/**
 * Keyword monitoring across platforms that ship a search CLI.
 *
 * One shape, several platforms: each maps its own JSON into SourceItem via a
 * small adapter below. This is the "eyes" half of the system — these providers
 * deliberately expose no write method, and the conformance suite enforces that.
 */

export interface CliSearchOptions {
  bin?: string;
  runner?: CliRunner;
  timeoutMs?: number;
  /** Default keywords when a query supplies none. */
  keywords?: string[];
  kind?: SourceKind;
}

/** Maps one platform's search payload into SourceItems. */
interface SearchAdapter {
  id: string;
  name: string;
  defaultBin: string;
  envBin: string;
  /** Build argv for one keyword. */
  args(keyword: string, limit: number): string[];
  /** Pull rows out of the parsed response. */
  rows(payload: any): any[];
  /** Map one row; return null to skip it. */
  map(row: any): Omit<SourceItem, 'id' | 'providerId' | 'kind'> & { externalId: string } | null;
}

const XHS_ADAPTER: SearchAdapter = {
  id: 'xhs-search',
  name: 'XiaoHongShu search',
  defaultBin: 'xhs',
  envBin: 'XHS_BIN',
  args: (keyword) => ['search', keyword, '--json'],
  rows: (p) => p?.data?.items ?? [],
  map: (row) => {
    const card = row?.note_card;
    const title = card?.display_title;
    if (!row?.id || !title) return null;

    // liked_count arrives as a string; treat it as the popularity signal.
    const likes = Number(card?.interact_info?.liked_count ?? 0);
    return {
      externalId: row.id,
      title,
      url: `https://www.xiaohongshu.com/explore/${row.id}`,
      ...(card?.user?.nickname ? { summary: `@${card.user.nickname}` } : {}),
      ...(Number.isFinite(likes) ? { score: likes } : {}),
      raw: row,
    };
  },
};

const TWITTER_ADAPTER: SearchAdapter = {
  id: 'twitter-search',
  name: 'Twitter/X search',
  defaultBin: 'twitter',
  envBin: 'TWITTER_BIN',
  args: (keyword, limit) => ['search', keyword, '-n', String(limit), '--json'],
  rows: (p) => p?.data?.tweets ?? p?.data?.results ?? p?.data?.items ?? [],
  map: (row) => {
    const externalId = row?.id_str ?? row?.id;
    const text = row?.full_text ?? row?.text;
    if (!externalId || !text) return null;

    const handle = row?.user?.screenName ?? row?.user?.screen_name ?? row?.user?.username;
    const published = row?.created_at ? new Date(row.created_at) : undefined;
    return {
      externalId: String(externalId),
      // Tweets have no title; the first line stands in for one.
      title: firstLine(text),
      url: `https://x.com/${handle ?? 'i'}/status/${externalId}`,
      summary: text,
      ...(Number.isFinite(Number(row?.favorite_count)) ? { score: Number(row.favorite_count) } : {}),
      ...(published && !Number.isNaN(published.getTime()) ? { publishedAt: published } : {}),
      raw: row,
    };
  },
};

const BILIBILI_ADAPTER: SearchAdapter = {
  id: 'bili-search',
  name: 'Bilibili search',
  defaultBin: 'bili',
  envBin: 'BILI_BIN',
  args: (keyword, limit) => ['search', keyword, '--type', 'video', '-n', String(limit), '--json'],
  rows: (p) => p?.data?.results ?? p?.data?.items ?? p?.data?.videos ?? [],
  map: (row) => {
    const bvid = row?.bvid ?? row?.id;
    const title = stripTags(row?.title);
    if (!bvid || !title) return null;

    const published = row?.pubdate ? new Date(Number(row.pubdate) * 1000) : undefined;
    return {
      externalId: String(bvid),
      title,
      url: `https://www.bilibili.com/video/${bvid}`,
      ...(row?.author ? { summary: `@${row.author}` } : {}),
      ...(Number.isFinite(Number(row?.play)) ? { score: Number(row.play) } : {}),
      ...(published && !Number.isNaN(published.getTime()) ? { publishedAt: published } : {}),
      raw: row,
    };
  },
};

export const SEARCH_ADAPTERS = {
  xiaohongshu: XHS_ADAPTER,
  twitter: TWITTER_ADAPTER,
  bilibili: BILIBILI_ADAPTER,
} as const;

export type SearchPlatform = keyof typeof SEARCH_ADAPTERS;

export class CliSearchSource implements SourceProvider {
  readonly info: ProviderInfo;
  readonly kind: SourceKind;

  private readonly adapter: SearchAdapter;
  private readonly bin: string;
  private readonly runner: CliRunner;
  private readonly timeoutMs: number;
  private readonly defaultKeywords: string[];

  constructor(platform: SearchPlatform, opts: CliSearchOptions = {}) {
    this.adapter = SEARCH_ADAPTERS[platform];
    if (!this.adapter) throw new Error(`unknown search platform: ${platform}`);

    this.info = {
      id: this.adapter.id,
      slot: 'source',
      name: this.adapter.name,
      upstream: this.adapter.defaultBin,
    };
    this.kind = opts.kind ?? 'trend';
    this.bin = opts.bin ?? process.env[this.adapter.envBin] ?? this.adapter.defaultBin;
    this.runner = opts.runner ?? defaultCliRunner;
    this.timeoutMs = opts.timeoutMs ?? 90_000;
    this.defaultKeywords = opts.keywords ?? [];
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const res = await runJsonCli<any>(this.runner, this.bin, ['status', '--json'], {
        timeoutMs: 30_000,
      });
      return res?.data?.authenticated === true
        ? { ok: true }
        : { ok: false, detail: `not logged in — run \`${this.bin} login\`` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : 'status failed' };
    }
  }

  async fetch(query: SourceQuery = {}): Promise<SourceItem[]> {
    const keywords = query.keywords?.length ? query.keywords : this.defaultKeywords;
    if (keywords.length === 0) return [];

    const limit = query.limit ?? 20;
    const seen = new Set<string>();
    const out: SourceItem[] = [];

    for (const keyword of keywords) {
      let payload: unknown;
      try {
        payload = await runJsonCli(this.runner, this.bin, this.adapter.args(keyword, limit), {
          timeoutMs: this.timeoutMs,
        });
      } catch (err) {
        // One dead keyword must not lose the others' results.
        if (err instanceof ProviderError && err.code === 'auth_expired') throw err;
        continue;
      }

      for (const row of this.adapter.rows(payload)) {
        const mapped = this.adapter.map(row);
        if (!mapped) continue;

        const id = `${this.info.id}:${mapped.externalId}`;
        if (seen.has(id)) continue; // Same item matched by two keywords.
        if (query.since && mapped.publishedAt && mapped.publishedAt < query.since) continue;
        seen.add(id);

        const { externalId: _drop, ...rest } = mapped;
        out.push({
          id,
          providerId: this.info.id,
          kind: this.kind,
          ...rest,
          ...(query.locale ? { locale: query.locale } : {}),
        });
      }
    }

    out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    return out.slice(0, limit);
  }
}

function firstLine(text: string, max = 80): string {
  const line = text.split('\n')[0]!.trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function stripTags(s: unknown): string | undefined {
  return typeof s === 'string' ? s.replace(/<[^>]+>/g, '').trim() : undefined;
}
