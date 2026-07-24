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
 * Voiceover via the system speech synthesiser.
 *
 * macOS ships `say` with usable Chinese and English voices and needs no
 * install, which makes it the one TTS that works on a fresh machine. Quality is
 * modest — it is a serviceable narration track for a short video, not a
 * broadcast voice. Better engines slot in behind the same interface when
 * they're installed; this is the floor, not the ceiling.
 *
 * `say` writes AIFF, so output is transcoded to AAC when ffmpeg is available —
 * video platforms reject AIFF.
 */

export interface TtsOptions {
  /** Voice name, e.g. "Tingting" (zh_CN) or "Samantha" (en_US). */
  voice?: string;
  /** Words per minute. `say` defaults to ~175. */
  rate?: number;
  outDir?: string;
  sayBin?: string;
  ffmpegBin?: string;
  runner?: CliRunner;
  timeoutMs?: number;
}

/** Sensible default voice per locale. */
const DEFAULT_VOICES: Record<string, string> = {
  'zh-CN': 'Tingting',
  'zh-TW': 'Meijia',
  'zh-HK': 'Sinji',
  'en-US': 'Samantha',
  'ja-JP': 'Kyoko',
};

export class TtsComposer implements ComposerProvider {
  readonly info: ProviderInfo = {
    id: 'tts-say',
    slot: 'composer',
    name: 'System TTS (macOS say)',
    upstream: 'say',
  };
  readonly produces: ContentKind[] = ['audio'];

  private readonly voice: string | undefined;
  private readonly rate: number | undefined;
  private readonly outDir: string;
  private readonly sayBin: string;
  private readonly ffmpegBin: string;
  private readonly runner: CliRunner;
  private readonly timeoutMs: number;

  constructor(opts: TtsOptions = {}) {
    this.voice = opts.voice;
    this.rate = opts.rate;
    this.outDir = opts.outDir ?? path.join(os.homedir(), '.mediabot', 'media');
    this.sayBin = opts.sayBin ?? process.env.SAY_BIN ?? 'say';
    this.ffmpegBin = opts.ffmpegBin ?? process.env.FFMPEG_BIN ?? 'ffmpeg';
    this.runner = opts.runner ?? defaultCliRunner;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    if (process.platform !== 'darwin') {
      return { ok: false, detail: '`say` is macOS-only; configure another TTS provider' };
    }
    try {
      await this.runner(this.sayBin, ['-v', '?'], { timeoutMs: 10_000 });
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : 'say unavailable' };
    }
  }

  /** Narrate the brief's script. */
  async composeAssets(brief: ContentBrief): Promise<MediaRef[]> {
    const script = scriptOf(brief);
    if (!script) return [];

    fs.mkdirSync(this.outDir, { recursive: true });
    const stem = newId('vo');
    const aiff = path.join(this.outDir, `${stem}.aiff`);

    const voice = this.voice ?? DEFAULT_VOICES[brief.locale] ?? DEFAULT_VOICES['en-US']!;
    await this.runner(
      this.sayBin,
      [
        '-v', voice,
        ...(this.rate ? ['-r', String(this.rate)] : []),
        '-o', aiff,
        script,
      ],
      { timeoutMs: this.timeoutMs },
    );

    if (!fs.existsSync(aiff)) {
      throw new ProviderError('say exited cleanly but wrote no audio', 'unknown', false);
    }

    // Video platforms reject AIFF; transcode when we can, keep AIFF when we
    // cannot rather than losing the narration entirely.
    const finalPath = await this.toAac(aiff, path.join(this.outDir, `${stem}.m4a`));

    return [
      {
        kind: 'audio',
        path: finalPath,
        mimeType: finalPath.endsWith('.m4a') ? 'audio/mp4' : 'audio/aiff',
        bytes: fs.statSync(finalPath).size,
        ...(await this.duration(finalPath)),
        alt: script.slice(0, 120),
      },
    ];
  }

  /** Contract-satisfying compose: the narration attached to each platform. */
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

  private async toAac(input: string, output: string): Promise<string> {
    try {
      await this.runner(
        this.ffmpegBin,
        ['-y', '-i', input, '-c:a', 'aac', '-b:a', '128k', output],
        { timeoutMs: this.timeoutMs },
      );
      if (fs.existsSync(output)) {
        fs.rmSync(input, { force: true });
        return output;
      }
    } catch {
      // ffmpeg missing or failed — fall through and keep the AIFF.
    }
    return input;
  }

  private async duration(file: string): Promise<{ durationSeconds?: number }> {
    try {
      const { stdout } = await this.runner(
        this.ffmpegBin.replace(/ffmpeg$/, 'ffprobe'),
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
        { timeoutMs: 20_000 },
      );
      const seconds = Number(stdout.trim());
      return Number.isFinite(seconds) ? { durationSeconds: Math.round(seconds * 10) / 10 } : {};
    } catch {
      // Duration is a nice-to-have; publishers only need it to enforce limits.
      return {};
    }
  }
}

/**
 * What to narrate.
 *
 * `meta.script` wins when the brief carries a purpose-written script, since a
 * post body full of hashtags and emoji makes terrible speech.
 */
export function scriptOf(brief: ContentBrief): string | null {
  const explicit = (brief as any).script;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();

  const source = brief.sources[0];
  const text = brief.goal ?? source?.summary ?? source?.title;
  return text && text.trim() ? text.trim() : null;
}
