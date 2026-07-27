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
 * Reddit discussion monitoring, via the `rdt` CLI.
 *
 * Read-only by construction, like every source. Reddit communities are more
 * hostile to marketing than most, so the value here is finding the few threads
 * where you genuinely have something to add — not volume.
 */

export interface RedditSourceOptions {
  bin?: string;
  runner?: CliRunner;
  timeoutMs?: number;
  keywords?: string[];
  /** Restrict the search to these subreddits. */
  subreddits?: string[];
  sort?: 'relevance' | 'hot' | 'top' | 'new' | 'comments';
  time?: 'hour' | 'day' | 'week' | 'month' | 'year' | 'all';
  kind?: SourceKind;
}

interface RedditListing {
  data?: {
    data?: {
      children?: Array<{ data?: RedditPost }>;
    };
  };
}

interface RedditPost {
  id?: string;
  title?: string;
  selftext?: string;
  permalink?: string;
  url?: string;
  score?: number;
  num_comments?: number;
  subreddit?: string;
  author?: string;
  created_utc?: number;
}

export class RedditSource implements SourceProvider {
  readonly info: ProviderInfo = {
    id: 'reddit',
    slot: 'source',
    name: 'Reddit search (rdt CLI)',
    upstream: 'rdt-cli',
  };
  readonly kind: SourceKind;

  private readonly bin: string;
  private readonly runner: CliRunner;
  private readonly timeoutMs: number;
  private readonly defaultKeywords: string[];
  private readonly subreddits: string[];
  private readonly sort: string;
  private readonly time: string;

  constructor(opts: RedditSourceOptions = {}) {
    this.kind = opts.kind ?? 'competitor';
    this.bin = opts.bin ?? process.env.RDT_BIN ?? 'rdt';
    this.runner = opts.runner ?? defaultCliRunner;
    this.timeoutMs = opts.timeoutMs ?? 90_000;
    this.defaultKeywords = opts.keywords ?? [];
    this.subreddits = opts.subreddits ?? [];
    this.sort = opts.sort ?? 'new';
    this.time = opts.time ?? 'week';
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const res = await runJsonCli<any>(this.runner, this.bin, ['status', '--json'], {
        timeoutMs: 30_000,
      });
      return res?.data?.authenticated === true
        ? { ok: true }
        : { ok: false, detail: 'not logged in — run `rdt login`' };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : 'rdt status failed' };
    }
  }

  async fetch(query: SourceQuery = {}): Promise<SourceItem[]> {
    const keywords = query.keywords?.length ? query.keywords : this.defaultKeywords;
    if (keywords.length === 0) return [];

    const limit = query.limit ?? 15;
    // One search per keyword × subreddit; a global search when none are named.
    const scopes = this.subreddits.length ? this.subreddits : [null];
    const seen = new Set<string>();
    const out: SourceItem[] = [];

    for (const keyword of keywords) {
      for (const subreddit of scopes) {
        let payload: RedditListing;
        try {
          payload = await runJsonCli<RedditListing>(
            this.runner,
            this.bin,
            [
              'search',
              keyword,
              ...(subreddit ? ['-r', subreddit] : []),
              '-s', this.sort,
              '-t', this.time,
              '-n', String(limit),
              '--json',
            ],
            { timeoutMs: this.timeoutMs },
          );
        } catch (err) {
          // A dead login must stop the sweep loudly; one bad keyword must not.
          if (err instanceof ProviderError && err.code === 'auth_expired') throw err;
          continue;
        }

        for (const child of payload?.data?.data?.children ?? []) {
          const post = child?.data;
          if (!post?.id || !post.title) continue;

          const id = `${this.info.id}:${post.id}`;
          if (seen.has(id)) continue;

          const publishedAt = post.created_utc ? new Date(post.created_utc * 1000) : undefined;
          if (query.since && publishedAt && publishedAt < query.since) continue;
          seen.add(id);

          out.push({
            id,
            providerId: this.info.id,
            kind: this.kind,
            title: post.title,
            url: post.permalink ? `https://www.reddit.com${post.permalink}` : post.url,
            ...(post.selftext?.trim() ? { summary: post.selftext.slice(0, 1000) } : {}),
            ...(typeof post.score === 'number' ? { score: post.score } : {}),
            ...(publishedAt ? { publishedAt } : {}),
            ...(query.locale ? { locale: query.locale } : {}),
            raw: post,
          });
        }
      }
    }

    out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    return out.slice(0, limit);
  }
}
