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

/**
 * Composer backed by the Claude Code CLI.
 *
 * Asks for a fenced ```json block and parses that rather than the raw output,
 * because models reliably wrap structured answers in prose. A parse failure is
 * reported as a ProviderError so the pipeline can mark the draft discarded —
 * it never retries, since re-running the same prompt mostly burns tokens.
 */

export interface ClaudeComposerOptions {
  id?: string;
  model?: string;
  cwd?: string;
  timeoutMs?: number;
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

  constructor(opts: ClaudeComposerOptions = {}) {
    this.info = { id: opts.id ?? 'claude', slot: 'composer', name: 'Claude Code composer' };
    this.opts = opts;
    this.runner = opts.runner ?? ((p, o) => runClaude(p, o));
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
    const parsed = parseFencedJson<{ variants?: ModelVariant[] }>(text);
    if (!parsed || !Array.isArray(parsed.variants)) {
      throw new ProviderError(
        'composer output contained no parseable ```json block with a "variants" array',
        'rejected',
        false,
      );
    }

    const requested = new Set(brief.targetPlatforms);
    const seen = new Set<string>();
    const variants: DraftVariant[] = [];

    for (const v of parsed.variants) {
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

    return { id: draftId, variants };
  }
}

function pickAssets(assets: MediaRef[] | undefined): MediaRef[] {
  return assets ? [...assets] : [];
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
    'You are drafting social content. Reply with ONE fenced ```json block and nothing else.',
    '',
    brief.goal ? `GOAL: ${brief.goal}` : 'GOAL: (none given)',
    `LOCALE: ${brief.locale}`,
    brief.style ? `STYLE: ${brief.style}` : '',
    '',
    'SOURCE MATERIAL:',
    sources,
    '',
    `TARGET PLATFORMS: ${brief.targetPlatforms.join(', ')}`,
    '',
    'Write a genuinely distinct variant per platform — different length, voice and',
    'tagging as that platform expects. Do not paraphrase one variant into the others.',
    'Use only the platform names listed above.',
    '',
    'Shape:',
    '```json',
    '{"variants":[{"platform":"<one of the targets>","title":"<optional>",',
    '"body":"<the post text>","meta":{"tags":["..."]}}]}',
    '```',
  ]
    .filter((l) => l !== '')
    .join('\n');
}
