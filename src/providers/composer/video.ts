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
 * Assembles a vertical short video from stills plus a narration track.
 *
 * Everything it needs is already local — generated covers, system TTS, ffmpeg —
 * so a slideshow-with-voiceover needs no model server and no cloud round trip.
 * That is deliberately the modest end of "AI video": it produces the format
 * Douyin and Channels actually take, without a ComfyUI install standing between
 * the user and their first published clip.
 *
 * Runs *after* the image and audio composers, consuming what they produced.
 */

export interface VideoComposerOptions {
  outDir?: string;
  ffmpegBin?: string;
  runner?: CliRunner;
  /** Output frame size. Defaults to 1080x1920 vertical. */
  width?: number;
  height?: number;
  fps?: number;
  /** Seconds per still when there is no narration to pace against. */
  defaultSlideSeconds?: number;
  timeoutMs?: number;
}

export class VideoComposer implements ComposerProvider {
  readonly info: ProviderInfo = {
    id: 'video-slideshow',
    slot: 'composer',
    name: 'Slideshow video (ffmpeg)',
    upstream: 'ffmpeg',
  };
  readonly produces: ContentKind[] = ['video'];

  private readonly outDir: string;
  private readonly ffmpegBin: string;
  private readonly runner: CliRunner;
  private readonly width: number;
  private readonly height: number;
  private readonly fps: number;
  private readonly defaultSlideSeconds: number;
  private readonly timeoutMs: number;

  constructor(opts: VideoComposerOptions = {}) {
    this.outDir = opts.outDir ?? path.join(os.homedir(), '.mediabot', 'media');
    this.ffmpegBin = opts.ffmpegBin ?? process.env.FFMPEG_BIN ?? 'ffmpeg';
    this.runner = opts.runner ?? defaultCliRunner;
    this.width = opts.width ?? 1080;
    this.height = opts.height ?? 1920;
    this.fps = opts.fps ?? 30;
    this.defaultSlideSeconds = opts.defaultSlideSeconds ?? 4;
    // Encoding a minute of 1080x1920 takes a while on CPU.
    this.timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      await this.runner(this.ffmpegBin, ['-version'], { timeoutMs: 15_000 });
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        detail: err instanceof Error ? err.message : 'ffmpeg not available — brew install ffmpeg',
      };
    }
  }

  /**
   * Build the clip from whatever stills and narration the brief carries.
   *
   * Returns nothing when there are no images: a video of a blank screen is
   * worse than no video, and the caller falls back to an image post.
   */
  async composeAssets(brief: ContentBrief): Promise<MediaRef[]> {
    const assets = brief.assets ?? [];
    const images = assets.filter((a) => a.kind === 'image');
    if (images.length === 0) return [];

    const audio = assets.find((a) => a.kind === 'audio');
    const totalSeconds = audio?.durationSeconds ?? images.length * this.defaultSlideSeconds;
    // Every still gets an equal share so the last one is not left hanging after
    // the narration ends.
    const perSlide = Math.max(1, totalSeconds / images.length);

    fs.mkdirSync(this.outDir, { recursive: true });
    const stem = newId('vid');
    const outPath = path.join(this.outDir, `${stem}.mp4`);
    const listPath = path.join(this.outDir, `${stem}.concat.txt`);

    fs.writeFileSync(listPath, buildConcatList(images.map((i) => i.path), perSlide));

    const filter =
      `scale=${this.width}:${this.height}:force_original_aspect_ratio=decrease,` +
      `pad=${this.width}:${this.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${this.fps}`;

    const args = [
      '-y',
      '-f', 'concat',
      // The list holds absolute paths we generated, not user input.
      '-safe', '0',
      '-i', listPath,
      ...(audio ? ['-i', audio.path] : []),
      '-vf', filter,
      '-c:v', 'libx264',
      // Required or many players and platforms refuse the file.
      '-pix_fmt', 'yuv420p',
      ...(audio ? ['-c:a', 'aac', '-b:a', '128k', '-shortest'] : []),
      outPath,
    ];

    try {
      await this.runner(this.ffmpegBin, args, { timeoutMs: this.timeoutMs });
    } finally {
      fs.rmSync(listPath, { force: true });
    }

    if (!fs.existsSync(outPath)) {
      throw new ProviderError('ffmpeg exited cleanly but wrote no video', 'unknown', false);
    }

    return [
      {
        kind: 'video',
        path: outPath,
        mimeType: 'video/mp4',
        bytes: fs.statSync(outPath).size,
        width: this.width,
        height: this.height,
        durationSeconds: Math.round(perSlide * images.length * 10) / 10,
        ...(images[0]?.path ? { thumbnailPath: images[0].path } : {}),
      },
    ];
  }

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
 * ffmpeg's concat demuxer format.
 *
 * The final image is repeated without a duration line — the demuxer drops the
 * last entry's duration otherwise, cutting the closing shot short.
 */
export function buildConcatList(paths: string[], perSlideSeconds: number): string {
  const lines: string[] = [];
  for (const p of paths) {
    lines.push(`file '${escapeConcatPath(p)}'`);
    lines.push(`duration ${perSlideSeconds.toFixed(3)}`);
  }
  const last = paths[paths.length - 1];
  if (last) lines.push(`file '${escapeConcatPath(last)}'`);
  return `${lines.join('\n')}\n`;
}

/** Single quotes terminate a concat path; escape them the way ffmpeg expects. */
function escapeConcatPath(p: string): string {
  return p.replace(/'/g, `'\\''`);
}
