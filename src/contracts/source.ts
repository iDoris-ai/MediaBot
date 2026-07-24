import type { Locale, MediaRef, ProviderInfo } from './common';

/**
 * Read-only inputs: trends, news, competitor activity, incoming comments.
 *
 * INVARIANT: a SourceProvider never writes to an external platform. Monitoring
 * output may only reach a briefing or the approval queue — it can never trigger
 * a publish directly. The conformance kit asserts this ("eyes, not hands").
 */
export interface SourceProvider {
  readonly info: ProviderInfo;
  readonly kind: SourceKind;

  /** Cheap readiness probe: binary present, MCP reachable, token valid. */
  healthCheck(): Promise<SourceHealth>;

  fetch(query: SourceQuery): Promise<SourceItem[]>;
}

export type SourceKind = 'trend' | 'news' | 'competitor' | 'comment';

export interface SourceHealth {
  ok: boolean;
  detail?: string;
}

export interface SourceQuery {
  keywords?: string[];
  /** Only return items published after this instant. */
  since?: Date;
  limit?: number;
  locale?: Locale;
}

export interface SourceItem {
  /**
   * MUST be `"<provider id>:<stable external id>"`. This is the primary key in
   * `source_items`, so a stable id is what makes repeated polling idempotent.
   */
  id: string;
  providerId: string;
  kind: SourceKind;
  title: string;
  url?: string;
  summary?: string;
  /** Popularity or relevance, provider-defined scale. */
  score?: number;
  locale?: Locale;
  publishedAt?: Date;
  media?: MediaRef[];
  /** Raw upstream payload, retained so items can be re-parsed later. */
  raw?: unknown;
}
