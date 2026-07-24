import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TtsComposer, scriptOf } from './tts';
import { runConformance } from '../../testing/conformance';
import { ProviderError, type ContentBrief } from '../../contracts';
import type { CliRunner } from '../../core/cli-adapter';

/** Stubs `say` and ffmpeg by writing the files they would have produced. */
function fakeAudio(
  calls: string[][] = [],
  opts: { sayWrites?: boolean; ffmpegWorks?: boolean; probeWorks?: boolean } = {},
): CliRunner {
  return async (bin, args) => {
    calls.push([path.basename(bin), ...args]);

    if (bin.endsWith('ffprobe')) {
      if (opts.probeWorks === false) throw new Error('no ffprobe');
      return { stdout: '12.34\n', stderr: '' };
    }
    if (bin.endsWith('ffmpeg')) {
      if (opts.ffmpegWorks === false) throw new Error('ffmpeg missing');
      const out = args[args.length - 1]!;
      fs.writeFileSync(out, 'aac-bytes');
      return { stdout: '', stderr: '' };
    }
    // say
    if (args[0] === '-v' && args[1] === '?') return { stdout: 'Tingting zh_CN', stderr: '' };
    if (opts.sayWrites !== false) {
      const out = args[args.indexOf('-o') + 1]!;
      fs.writeFileSync(out, 'aiff-bytes');
    }
    return { stdout: '', stderr: '' };
  };
}

function outDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mediabot-tts-'));
}

const brief = (over: Partial<ContentBrief> = {}): ContentBrief => ({
  sources: [],
  targetPlatforms: ['douyin'],
  locale: 'zh-CN',
  goal: '今天讲讲本地跑大模型',
  ...over,
});

test('synthesises narration and transcodes it to AAC', async () => {
  const calls: string[][] = [];
  const c = new TtsComposer({ runner: fakeAudio(calls), outDir: outDir() });

  const [audio] = await c.composeAssets(brief());

  assert.equal(audio!.kind, 'audio');
  assert.ok(audio!.path.endsWith('.m4a'), 'AIFF is rejected by video platforms');
  assert.equal(audio!.mimeType, 'audio/mp4');
  assert.equal(audio!.durationSeconds, 12.3);
  assert.ok(fs.existsSync(audio!.path));
});

test('picks the voice from the locale', async () => {
  const calls: string[][] = [];
  const c = new TtsComposer({ runner: fakeAudio(calls), outDir: outDir() });

  await c.composeAssets(brief({ locale: 'zh-CN' }));
  assert.equal(calls[0]![calls[0]!.indexOf('-v') + 1], 'Tingting');

  calls.length = 0;
  await c.composeAssets(brief({ locale: 'en-US' }));
  assert.equal(calls[0]![calls[0]!.indexOf('-v') + 1], 'Samantha');
});

test('an unknown locale falls back rather than failing', async () => {
  const calls: string[][] = [];
  const c = new TtsComposer({ runner: fakeAudio(calls), outDir: outDir() });
  await c.composeAssets(brief({ locale: 'xx-YY' }));
  assert.equal(calls[0]![calls[0]!.indexOf('-v') + 1], 'Samantha');
});

test('an explicit voice and rate override the defaults', async () => {
  const calls: string[][] = [];
  const c = new TtsComposer({ runner: fakeAudio(calls), outDir: outDir(), voice: 'Meijia', rate: 200 });

  await c.composeAssets(brief());
  assert.equal(calls[0]![calls[0]!.indexOf('-v') + 1], 'Meijia');
  assert.equal(calls[0]![calls[0]!.indexOf('-r') + 1], '200');
});

test('keeps the AIFF when ffmpeg is unavailable, rather than losing the audio', async () => {
  const c = new TtsComposer({
    runner: fakeAudio([], { ffmpegWorks: false }),
    outDir: outDir(),
  });

  const [audio] = await c.composeAssets(brief());
  assert.ok(audio!.path.endsWith('.aiff'), 'degraded format beats no narration at all');
  assert.equal(audio!.mimeType, 'audio/aiff');
  assert.ok(fs.existsSync(audio!.path));
});

test('a missing duration does not fail the run', async () => {
  const c = new TtsComposer({ runner: fakeAudio([], { probeWorks: false }), outDir: outDir() });
  const [audio] = await c.composeAssets(brief());
  assert.equal(audio!.durationSeconds, undefined);
  assert.ok(audio!.path, 'duration is only needed for platform limits');
});

test('say exiting cleanly without writing a file is treated as failure', async () => {
  const c = new TtsComposer({ runner: fakeAudio([], { sayWrites: false }), outDir: outDir() });
  await assert.rejects(c.composeAssets(brief()), (err: unknown) => {
    assert.ok(err instanceof ProviderError);
    assert.match(err.message, /wrote no audio/);
    return true;
  });
});

test('nothing to narrate means no synthesis', async () => {
  const calls: string[][] = [];
  const c = new TtsComposer({ runner: fakeAudio(calls), outDir: outDir() });
  assert.deepEqual(await c.composeAssets({ sources: [], targetPlatforms: ['x'], locale: 'zh-CN' }), []);
  assert.equal(calls.length, 0);
});

test('an explicit script wins over the post body', () => {
  const b = { ...brief(), script: '专门写的口播稿' } as any;
  assert.equal(
    scriptOf(b),
    '专门写的口播稿',
    'a post body full of hashtags and emoji makes terrible speech',
  );
});

test('scriptOf falls back through goal, summary and title', () => {
  assert.equal(scriptOf(brief({ goal: '目标文案' })), '目标文案');
  assert.equal(
    scriptOf(brief({
      goal: undefined,
      sources: [{ id: 'a:1', providerId: 'a', kind: 'news', title: '标题', summary: '摘要' }],
    })),
    '摘要',
  );
  assert.equal(scriptOf({ sources: [], targetPlatforms: [], locale: 'zh-CN' }), null);
});

test('healthCheck reflects the platform', async () => {
  const c = new TtsComposer({ runner: fakeAudio(), outDir: outDir() });
  const h = await c.healthCheck();
  if (process.platform === 'darwin') {
    assert.equal(h.ok, true);
  } else {
    assert.match(h.detail!, /macOS-only/);
  }
});

test('passes the composer conformance suite', async () => {
  const c = new TtsComposer({ runner: fakeAudio(), outDir: outDir() });
  const report = await runConformance(c, 'composer');
  assert.ok(report.passed, report.checks.filter((x) => !x.ok).map((x) => `${x.name}: ${x.detail}`).join('\n'));
});
