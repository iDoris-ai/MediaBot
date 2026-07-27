import type {
  ComposerProvider,
  ContentBrief,
  ContentKind,
  Draft,
  DraftVariant,
  MediaRef,
  ProviderInfo,
} from '../../contracts';
import { ProviderError } from '../../contracts';
import { newId } from '../../core/identity';
import { parseFencedJson, runClaude, type ClaudeOptions } from '../../core/claude';
import { findDuplicates, shapeGuidance } from '../../core/platform-shapes';

/**
 * Composer backed by the Claude Code CLI.
 *
 * Output uses a delimiter format rather than JSON. That is not a style
 * preference: long-form prose inside a JSON string has to escape every
 * newline, and measured over repeated real runs the model got that wrong
 * roughly one time in three — producing a literal control character and an
 * unparseable response. A delimited block needs no escaping at all, so
 * newlines, quotes and even fenced code inside the body are simply content.
 *
 * JSON is still accepted as a fallback, since short drafts encode fine and
 * older prompts may still elicit it.
 */

export interface ClaudeComposerOptions {
  id?: string;
  model?: string;
  cwd?: string;
  timeoutMs?: number;
  /**
   * Similarity above which two variants count as copies of each other.
   * Set to 1 to disable the check.
   */
  duplicateThreshold?: number;
  /** Called when variants come back too alike. */
  onDuplicates?: (findings: Array<{ a: string; b: string; similarity: number }>) => void;
  /** Injectable for tests. */
  runner?: (prompt: string, opts?: ClaudeOptions) => Promise<{ text: string; transcript: string }>;
}

interface ModelVariant {
  platform?: string;
  title?: string;
  body?: string;
  meta?: Record<string, unknown>;
}

export class ClaudeComposer implements ComposerProvider {
  readonly info: ProviderInfo;
  readonly produces: ContentKind[] = ['text'];

  private readonly opts: ClaudeComposerOptions;
  private readonly runner: NonNullable<ClaudeComposerOptions['runner']>;
  private readonly duplicateThreshold: number;

  constructor(opts: ClaudeComposerOptions = {}) {
    this.info = { id: opts.id ?? 'claude', slot: 'composer', name: 'Claude Code composer' };
    this.opts = opts;
    this.runner = opts.runner ?? ((p, o) => runClaude(p, o));
    this.duplicateThreshold = opts.duplicateThreshold ?? 0.75;
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true };
  }

  async compose(brief: ContentBrief): Promise<Draft> {
    const draftId = newId('draft');
    if (brief.targetPlatforms.length === 0) return { id: draftId, variants: [] };

    const raw = await this.runner(buildPrompt(brief), {
      ...(this.opts.model ? { model: this.opts.model } : {}),
      ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}),
      ...(this.opts.timeoutMs ? { timeoutMs: this.opts.timeoutMs } : {}),
    });

    const text = raw.text || raw.transcript;
    const modelVariants = parseVariants(text);
    if (modelVariants === null) {
      throw new ProviderError(
        'composer output contained no parseable variant blocks',
        'rejected',
        false,
      );
    }

    const requested = new Set(brief.targetPlatforms);
    const seen = new Set<string>();
    const variants: DraftVariant[] = [];

    for (const v of modelVariants) {
      const platform = typeof v.platform === 'string' ? v.platform : undefined;
      // Drop anything for a platform we did not ask for — the conformance suite
      // enforces this, and it stops a stray variant reaching an account that
      // was never in scope for this brief.
      if (!platform || !requested.has(platform) || seen.has(platform)) continue;
      if (typeof v.body !== 'string' || v.body.trim().length === 0) continue;

      seen.add(platform);
      variants.push({
        id: newId('dv'),
        platform,
        ...(typeof v.title === 'string' && v.title.trim() ? { title: v.title.trim() } : {}),
        body: v.body.trim(),
        media: pickAssets(brief.assets),
        ...(v.meta && typeof v.meta === 'object' ? { meta: v.meta } : {}),
      });
    }

    if (variants.length === 0) {
      throw new ProviderError(
        `composer returned no usable variant for any of: ${brief.targetPlatforms.join(', ')}`,
        'rejected',
        false,
      );
    }

    // Asking for distinct variants in a prompt is a request, not a guarantee.
    // Near-identical variants read as syndicated filler on every platform at
    // once, so they are surfaced rather than shipped silently.
    if (this.duplicateThreshold < 1 && variants.length > 1) {
      const dupes = findDuplicates(variants, this.duplicateThreshold);
      if (dupes.length) this.opts.onDuplicates?.(dupes);
    }

    return { id: draftId, variants };
  }
}

function pickAssets(assets: MediaRef[] | undefined): MediaRef[] {
  return assets ? [...assets] : [];
}

/**
 * Read the delimited blocks, falling back to JSON.
 *
 * Returns null only when neither format yields anything usable.
 */
export function parseVariants(text: string): ModelVariant[] | null {
  const delimited = parseDelimitedVariants(text);
  if (delimited.length) return delimited;

  const json = parseFencedJson<{ variants?: ModelVariant[] }>(text);
  return json && Array.isArray(json.variants) ? json.variants : null;
}

const BLOCK = /<<<VARIANT\s+platform=([^\s>]+)\s*>>>([\s\S]*?)<<<END>>>/gi;

export function parseDelimitedVariants(text: string): ModelVariant[] {
  const out: ModelVariant[] = [];
  BLOCK.lastIndex = 0;

  let m: RegExpExecArray | null;
  while ((m = BLOCK.exec(text)) !== null) {
    const platform = m[1]!.trim();
    const block = m[2] ?? '';

    // Everything after the BODY: marker is the post, verbatim.
    const bodyStart = block.search(/^BODY:[^\S\n]*$/m);
    if (bodyStart < 0) continue;

    const header = block.slice(0, bodyStart);
    const body = block
      .slice(bodyStart)
      .replace(/^BODY:[^\S\n]*\n?/, '')
      .trim();
    if (!body) continue;

    const title = /^TITLE:[^\S\n]*(.+)$/m.exec(header)?.[1]?.trim();
    const tagLine = /^TAGS:[^\S\n]*(.+)$/m.exec(header)?.[1];
    const tags = tagLine
      ? tagLine.split(/[,，]/).map((t) => t.trim().replace(/^#/, '')).filter(Boolean)
      : undefined;

    out.push({
      platform,
      ...(title ? { title } : {}),
      body,
      ...(tags?.length ? { meta: { tags } } : {}),
    });
  }
  return out;
}

export function buildPrompt(brief: ContentBrief): string {
  const sources = brief.sources.length
    ? brief.sources
        .map((s, i) => {
          const parts = [`${i + 1}. ${s.title}`];
          if (s.url) parts.push(`   url: ${s.url}`);
          if (s.summary) parts.push(`   summary: ${s.summary}`);
          return parts.join('\n');
        })
        .join('\n')
    : '(no source material — write from the goal alone)';

  return [
    'You are drafting social content. Reply using ONLY the block format shown at',
    'the end of this prompt — no preamble, no JSON, no commentary.',
    '',
    brief.goal ? `GOAL: ${brief.goal}` : 'GOAL: (none given)',
    `LOCALE: ${brief.locale}`,
    brief.style ? `STYLE: ${brief.style}` : '',
    '',
    'SOURCE MATERIAL:',
    sources,
    '',
    'TARGET PLATFORMS — each has its own shape, follow it:',
    brief.targetPlatforms.map(shapeGuidance).join('\n'),
    '',
    'Write a genuinely distinct variant per platform. Not a translation of one',
    'into another, not the same paragraphs reordered — different length, structure',
    'and voice as described above. A reader who saw two of them should not feel',
    'they read the same post twice.',
    'Use only the platform names listed above.',
    '',
    'OUTPUT FORMAT — one block per platform, nothing else:',
    '',
    '<<<VARIANT platform=xiaohongshu>>>',
    'TITLE: the title, or omit this line entirely',
    'TAGS: tag1, tag2',
    'BODY:',
    'The post text. Write it naturally — real line breaks, quotes and even',
    'code fences are all fine here, nothing needs escaping.',
    '<<<END>>>',
    '',
    'Repeat that block for each target platform.',
  ]
    .filter((l) => l !== '')
    .join('\n');
}
