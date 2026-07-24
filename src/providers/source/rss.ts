import { createHash } from 'crypto';
import type {
  ProviderInfo,
  SourceItem,
  SourceKind,
  SourceProvider,
  SourceQuery,
} from '../../contracts';
import { ProviderError } from '../../contracts';

/**
 * RSS / Atom source.
 *
 * Deliberately dependency-free: a small regex reader covers the subset of feed
 * markup that matters here (title, link, date, summary) without pulling an XML
 * parser into the plugin ABI's dependency surface.
 */

export interface RssOptions {
  /** Feed URLs to poll. */
  feeds: string[];
  id?: string;
  kind?: SourceKind;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class RssSourceProvider implements SourceProvider {
  readonly info: ProviderInfo;
  readonly kind: SourceKind;

  private readonly feeds: string[];
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: RssOptions) {
    this.info = { id: opts.id ?? 'rss', slot: 'source', name: 'RSS / Atom' };
    this.kind = opts.kind ?? 'news';
    this.feeds = opts.feeds;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    if (this.feeds.length === 0) return { ok: false, detail: 'no feeds configured' };
    if (typeof this.fetchImpl !== 'function') return { ok: false, detail: 'fetch unavailable' };
    return { ok: true };
  }

  async fetch(query: SourceQuery = {}): Promise<SourceItem[]> {
    const collected: SourceItem[] = [];

    for (const feed of this.feeds) {
      const xml = await this.get(feed);
      for (const entry of parseFeed(xml)) {
        if (query.since && entry.publishedAt && entry.publishedAt < query.since) continue;
        if (query.keywords?.length) {
          const hay = `${entry.title} ${entry.summary ?? ''}`.toLowerCase();
          if (!query.keywords.some((k) => hay.includes(k.toLowerCase()))) continue;
        }

        collected.push({
          // Prefer the feed's own guid; fall back to a hash of the link/title so
          // the id stays stable across polls even for feeds without a guid.
          id: `${this.info.id}:${entry.guid ?? stableKey(entry.link ?? entry.title)}`,
          providerId: this.info.id,
          kind: this.kind,
          title: entry.title,
          ...(entry.link ? { url: entry.link } : {}),
          ...(entry.summary ? { summary: entry.summary } : {}),
          ...(query.locale ? { locale: query.locale } : {}),
          ...(entry.publishedAt ? { publishedAt: entry.publishedAt } : {}),
          raw: { feed, ...entry },
        });
      }
    }

    // Newest first, so `limit` keeps the most recent rather than an arbitrary slice.
    collected.sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));
    return typeof query.limit === 'number' ? collected.slice(0, query.limit) : collected;
  }

  private async get(url: string): Promise<string> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, { signal: ctl.signal });
      if (!res.ok) {
        throw new ProviderError(
          `feed ${url} returned HTTP ${res.status}`,
          res.status === 429 ? 'rate_limited' : res.status >= 500 ? 'transient' : 'unknown',
          res.status === 429 || res.status >= 500,
        );
      }
      return await res.text();
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(`failed to fetch ${url}`, 'transient', true, err);
    } finally {
      clearTimeout(timer);
    }
  }
}

interface FeedEntry {
  title: string;
  guid?: string;
  link?: string;
  summary?: string;
  publishedAt?: Date;
}

/** Parse RSS `<item>` and Atom `<entry>` elements. */
export function parseFeed(xml: string): FeedEntry[] {
  const entries: FeedEntry[] = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? [];

  for (const block of blocks) {
    const title = decode(tag(block, 'title'));
    if (!title) continue;

    const dateText =
      tag(block, 'pubDate') ?? tag(block, 'published') ?? tag(block, 'updated') ?? tag(block, 'dc:date');
    const parsed = dateText ? new Date(dateText) : undefined;

    entries.push({
      title,
      ...(tag(block, 'guid') || tag(block, 'id')
        ? { guid: decode(tag(block, 'guid') ?? tag(block, 'id'))! }
        : {}),
      ...(linkOf(block) ? { link: linkOf(block)! } : {}),
      ...(tag(block, 'description') || tag(block, 'summary')
        ? { summary: decode(tag(block, 'description') ?? tag(block, 'summary'))! }
        : {}),
      ...(parsed && !Number.isNaN(parsed.getTime()) ? { publishedAt: parsed } : {}),
    });
  }
  return entries;
}

function tag(block: string, name: string): string | undefined {
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m?.[1]?.trim();
}

function linkOf(block: string): string | undefined {
  const text = tag(block, 'link');
  if (text) return text;
  // Atom puts the URL in an attribute: <link href="..."/>
  return /<link\b[^>]*href=["']([^"']+)["']/i.exec(block)?.[1];
}

function decode(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

function stableKey(s: string): string {
  return createHash('sha1').update(s, 'utf8').digest('hex').slice(0, 16);
}
