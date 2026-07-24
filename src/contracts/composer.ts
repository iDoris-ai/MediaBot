import type { Locale, MediaRef, ProviderInfo } from './common';
import type { SourceItem } from './source';

/** What a composer can produce. A provider may produce several. */
export type ContentKind = 'text' | 'image' | 'video' | 'audio';

/**
 * Turns source material into platform-specific drafts.
 *
 * Composers never publish. They return a Draft; the pipeline validates it and
 * routes it to the approval queue.
 */
export interface ComposerProvider {
  readonly info: ProviderInfo;
  readonly produces: ContentKind[];

  healthCheck(): Promise<{ ok: boolean; detail?: string }>;

  compose(brief: ContentBrief): Promise<Draft>;
}

export interface ContentBrief {
  /** Optional goal context from the goal layer — shapes angle and CTA. */
  goal?: string;
  /** Material to draw from. May be empty for a purely goal-driven brief. */
  sources: SourceItem[];
  /**
   * Platforms to produce variants for. A composer SHOULD emit one variant per
   * platform; platforms it cannot serve are simply omitted and get skipped.
   */
  targetPlatforms: string[];
  locale: Locale;
  /** Free-form voice/style guidance. */
  style?: string;
  /** Existing assets the composer may reuse instead of generating new ones. */
  assets?: MediaRef[];
}

export interface Draft {
  id: string;
  variants: DraftVariant[];
}

/**
 * One platform's rendition of a piece of content.
 *
 * Variants are NOT copies of one another — XiaoHongShu and LinkedIn want
 * different voice, length, and tagging. Producing genuinely distinct variants
 * is the composer's job.
 */
export interface DraftVariant {
  id: string;
  platform: string;
  title?: string;
  body: string;
  media: MediaRef[];
  /** Platform-specific extras: topics, tags, collection, location, visibility. */
  meta?: Record<string, unknown>;
}
