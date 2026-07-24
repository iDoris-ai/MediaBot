import type {
  ComposerProvider,
  ContentBrief,
  ContentKind,
  Draft,
  MediaRef,
  ProviderInfo,
} from '../../contracts';

/**
 * Runs asset generators first, then a text composer with their output attached.
 *
 * This is how a post ends up with both words and a cover: image/audio/video
 * providers produce files via `composeAssets`, and the text composer receives
 * them as `brief.assets` and attaches them to every variant it writes.
 *
 * Asset generation is best-effort — a failed cover must not cost you the post.
 * The text composer is not: if it fails there is nothing to publish.
 */

export interface ChainComposerOptions {
  /** Providers implementing composeAssets; run before the text composer. */
  assetProviders?: ComposerProvider[];
  /** The composer that writes the actual variants. */
  textComposer: ComposerProvider;
  id?: string;
  onAssetError?: (providerId: string, err: unknown) => void;
}

export class ChainComposer implements ComposerProvider {
  readonly info: ProviderInfo;
  readonly produces: ContentKind[];

  private readonly assetProviders: ComposerProvider[];
  private readonly textComposer: ComposerProvider;
  private readonly onAssetError: ((providerId: string, err: unknown) => void) | undefined;

  constructor(opts: ChainComposerOptions) {
    this.assetProviders = opts.assetProviders ?? [];
    this.textComposer = opts.textComposer;
    this.onAssetError = opts.onAssetError;
    this.info = {
      id: opts.id ?? 'chain',
      slot: 'composer',
      name: `Chain (${[...this.assetProviders.map((p) => p.info.id), this.textComposer.info.id].join(' → ')})`,
    };
    this.produces = Array.from(
      new Set([...this.assetProviders.flatMap((p) => p.produces), ...this.textComposer.produces]),
    );
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    // Only the text composer is required; a broken asset generator degrades to
    // a text-only post rather than blocking the chain.
    const text = await this.textComposer.healthCheck();
    if (!text.ok) return { ok: false, detail: `text composer: ${text.detail ?? 'unhealthy'}` };

    const degraded: string[] = [];
    for (const p of this.assetProviders) {
      const h = await p.healthCheck();
      if (!h.ok) degraded.push(`${p.info.id}: ${h.detail ?? 'unhealthy'}`);
    }
    return degraded.length ? { ok: true, detail: `degraded — ${degraded.join('; ')}` } : { ok: true };
  }

  async compose(brief: ContentBrief): Promise<Draft> {
    const generated: MediaRef[] = [];

    for (const provider of this.assetProviders) {
      if (!provider.composeAssets) continue;
      try {
        generated.push(...(await provider.composeAssets(brief)));
      } catch (err) {
        // A missing cover is a worse post, not a lost one.
        this.onAssetError?.(provider.info.id, err);
      }
    }

    return this.textComposer.compose({
      ...brief,
      assets: [...(brief.assets ?? []), ...generated],
    });
  }
}
