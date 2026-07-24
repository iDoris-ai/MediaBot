import fs from 'fs';
import os from 'os';
import path from 'path';
import type {
  ComposerProvider,
  ContentBrief,
  ContentKind,
  Draft,
  MediaRef,
  ProviderInfo,
} from '../../contracts';
import { ProviderError } from '../../contracts';
import { defaultCliRunner, type CliRunner } from '../../core/cli-adapter';
import { newId } from '../../core/identity';

/**
 * Cover-image generation with the local FLUX.2 Klein model via mflux (MLX).
 *
 * Runs entirely on-device: no image API, no per-image cost, and nothing about
 * an unpublished post leaves the machine. The trade-off is wall-clock — roughly
 * 40s at the fast preset — which is why the daemon generates covers during the
 * scheduled compose step rather than while a human waits at the console.
 */

export type FluxMode = 'fast' | 'quality' | 'full';

const PRESETS: Record<FluxMode, { steps: number; size: number }> = {
  fast: { steps: 8, size: 768 },
  quality: { steps: 16, size: 1024 },
  full: { steps: 20, size: 1024 },
};

export interface FluxImageOptions {
  /** Python from the ML venv that has mflux installed. */
  python?: string;
  modelPath?: string;
  outDir?: string;
  mode?: FluxMode;
  /** Fixed seed keeps a rerun of the same brief reproducible. */
  seed?: number;
  runner?: CliRunner;
  timeoutMs?: number;
  now?: () => number;
}

export class FluxImageComposer implements ComposerProvider {
  readonly info: ProviderInfo = {
    id: 'flux-image',
    slot: 'composer',
    name: 'FLUX.2 Klein (local MLX)',
    upstream: 'mflux',
  };
  readonly produces: ContentKind[] = ['image'];

  private readonly bin: string;
  private readonly modelPath: string;
  private readonly outDir: string;
  private readonly mode: FluxMode;
  private readonly seed: number;
  private readonly runner: CliRunner;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(opts: FluxImageOptions = {}) {
    this.bin =
      opts.python ??
      process.env.MFLUX_BIN ??
      path.join(os.homedir(), 'venvs', 'ml', 'bin', 'mflux-generate-flux2');
    this.modelPath =
      opts.modelPath ??
      process.env.FLUX_MODEL ??
      path.join(os.homedir(), '.omlx', 'models', 'FLUX.2-klein-4B-mflux-4bit');
    this.outDir = opts.outDir ?? path.join(os.homedir(), '.mediabot', 'media');
    this.mode = opts.mode ?? 'fast';
    this.seed = opts.seed ?? 42;
    this.runner = opts.runner ?? defaultCliRunner;
    // Generation is slow by nature; a short timeout would kill valid runs.
    this.timeoutMs = opts.timeoutMs ?? 10 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    if (!fs.existsSync(this.bin)) {
      return { ok: false, detail: `mflux not found at ${this.bin} — pip install mflux in the ML venv` };
    }
    if (!fs.existsSync(this.modelPath)) {
      return { ok: false, detail: `model not found at ${this.modelPath} — run \`mdt download\`` };
    }
    return { ok: true };
  }

  /** Generate one cover image for the brief. */
  async composeAssets(brief: ContentBrief): Promise<MediaRef[]> {
    const prompt = buildImagePrompt(brief);
    if (!prompt) return [];

    const preset = PRESETS[this.mode];
    fs.mkdirSync(this.outDir, { recursive: true });
    const outPath = path.join(this.outDir, `${newId('img')}.png`);

    await this.runner(
      this.bin,
      [
        '--model', this.modelPath,
        '--base-model', 'flux2-klein-4b',
        '--prompt', prompt,
        '--steps', String(preset.steps),
        '--seed', String(this.seed),
        '--width', String(preset.size),
        '--height', String(preset.size),
        '--low-ram',
        '--output', outPath,
      ],
      { timeoutMs: this.timeoutMs },
    );

    // mflux reports success on stdout but the file is what matters; a missing
    // file means the run failed in a way the exit code did not surface.
    if (!fs.existsSync(outPath)) {
      throw new ProviderError('mflux reported success but wrote no image', 'unknown', false);
    }

    return [
      {
        kind: 'image',
        path: outPath,
        mimeType: 'image/png',
        bytes: fs.statSync(outPath).size,
        width: preset.size,
        height: preset.size,
        alt: prompt.slice(0, 120),
      },
    ];
  }

  /**
   * Contract-satisfying compose: one media-only variant per target platform.
   *
   * On its own this rarely publishes — most platforms need text too — so the
   * normal path is `composeAssets` feeding a text composer via ChainComposer.
   */
  async compose(brief: ContentBrief): Promise<Draft> {
    const media = await this.composeAssets(brief);
    return {
      id: newId('draft'),
      variants: brief.targetPlatforms.map((platform) => ({
        id: newId('dv'),
        platform,
        body: '',
        media: [...media],
      })),
    };
  }
}

/**
 * Turn a brief into an image prompt.
 *
 * English prompts produce noticeably better results from FLUX, so the subject
 * is passed through but the styling directives are always English.
 */
export function buildImagePrompt(brief: ContentBrief): string | null {
  const subject = brief.goal ?? brief.sources[0]?.title ?? brief.style;
  if (!subject) return null;

  const style = brief.style ? `${brief.style}, ` : '';
  return `${subject}. ${style}editorial cover illustration, clean composition, ` +
    `soft lighting, high detail, no text, no watermark, no logo`;
}
