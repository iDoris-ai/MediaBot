import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { VideoComposer, buildConcatList } from './video';
import { runConformance } from '../../testing/conformance';
import { ProviderError, type ContentBrief, type MediaRef } from '../../contracts';
import type { CliRunner } from '../../core/cli-adapter';

function fakeFfmpeg(calls: string[][] = [], opts: { writes?: boolean } = {}): CliRunner {
  return async (bin, args) => {
    calls.push(args);
    if (args[0] === '-version') return { stdout: 'ffmpeg version 7', stderr: '' };
    if (opts.writes !== false) {
      const out = args[args.length - 1]!;
      fs.writeFileSync(out, 'mp4-bytes');
    }
    return { stdout: '', stderr: '' };
  };
}

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mediabot-vid-'));
}

function image(dir: string, name: string): MediaRef {
  const p = path.join(dir, name);
  fs.writeFileSync(p, 'png');
  return { kind: 'image', path: p };
}

function brief(assets: MediaRef[]): ContentBrief {
  return { sources: [], targetPlatforms: ['douyin'], locale: 'zh-CN', assets };
}

test('builds a vertical mp4 from stills and narration', async () => {
  const dir = tmp();
  const calls: string[][] = [];
  const c = new VideoComposer({ runner: fakeFfmpeg(calls), outDir: dir });

  const [video] = await c.composeAssets(
    brief([
      image(dir, 'a.png'),
      image(dir, 'b.png'),
      { kind: 'audio', path: path.join(dir, 'vo.m4a'), durationSeconds: 10 },
    ]),
  );

  assert.equal(video!.kind, 'video');
  assert.equal(video!.mimeType, 'video/mp4');
  assert.equal(video!.width, 1080);
  assert.equal(video!.height, 1920);
  assert.equal(video!.durationSeconds, 10, 'the clip matches the narration length');
  assert.ok(fs.existsSync(video!.path));
});

test('the first still becomes the thumbnail', async () => {
  const dir = tmp();
  const first = image(dir, 'a.png');
  const c = new VideoComposer({ runner: fakeFfmpeg(), outDir: dir });

  const [video] = await c.composeAssets(brief([first, image(dir, 'b.png')]));
  assert.equal(video!.thumbnailPath, first.path, 'platforms want a cover frame');
});

test('slide timing divides the narration evenly across stills', async () => {
  const dir = tmp();
  const calls: string[][] = [];
  const c = new VideoComposer({ runner: fakeFfmpeg(calls), outDir: dir });

  // Capture the concat list before it is cleaned up.
  let listContents = '';
  const spy: CliRunner = async (bin, args) => {
    const listPath = args[args.indexOf('-i') + 1]!;
    listContents = fs.readFileSync(listPath, 'utf8');
    return fakeFfmpeg(calls)(bin, args);
  };
  const c2 = new VideoComposer({ runner: spy, outDir: dir });
  void c;

  await c2.composeAssets(
    brief([
      image(dir, 'a.png'),
      image(dir, 'b.png'),
      image(dir, 'c.png'),
      { kind: 'audio', path: path.join(dir, 'vo.m4a'), durationSeconds: 9 },
    ]),
  );

  assert.match(listContents, /duration 3\.000/, '9s over 3 stills is 3s each');
});

test('without narration it falls back to a fixed slide length', async () => {
  const dir = tmp();
  const c = new VideoComposer({ runner: fakeFfmpeg(), outDir: dir, defaultSlideSeconds: 5 });

  const [video] = await c.composeAssets(brief([image(dir, 'a.png'), image(dir, 'b.png')]));
  assert.equal(video!.durationSeconds, 10);
});

test('audio is muxed only when narration exists', async () => {
  const dir = tmp();
  const calls: string[][] = [];
  const c = new VideoComposer({ runner: fakeFfmpeg(calls), outDir: dir });

  await c.composeAssets(brief([image(dir, 'a.png')]));
  assert.ok(!calls[0]!.includes('-shortest'), 'no audio stream, no -shortest');

  calls.length = 0;
  await c.composeAssets(
    brief([image(dir, 'b.png'), { kind: 'audio', path: path.join(dir, 'vo.m4a'), durationSeconds: 3 }]),
  );
  assert.ok(calls[0]!.includes('-shortest'));
  assert.ok(calls[0]!.includes('aac'));
});

test('output is encoded for broad platform compatibility', async () => {
  const dir = tmp();
  const calls: string[][] = [];
  const c = new VideoComposer({ runner: fakeFfmpeg(calls), outDir: dir });

  await c.composeAssets(brief([image(dir, 'a.png')]));
  const args = calls[0]!;

  assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
  assert.equal(
    args[args.indexOf('-pix_fmt') + 1],
    'yuv420p',
    'without yuv420p many players and platforms reject the file',
  );
  assert.match(args[args.indexOf('-vf') + 1]!, /pad=1080:1920/, 'letterboxed to vertical, not stretched');
});

test('no images means no video rather than a blank clip', async () => {
  const dir = tmp();
  const calls: string[][] = [];
  const c = new VideoComposer({ runner: fakeFfmpeg(calls), outDir: dir });

  assert.deepEqual(
    await c.composeAssets(brief([{ kind: 'audio', path: '/tmp/vo.m4a', durationSeconds: 5 }])),
    [],
  );
  assert.equal(calls.length, 0, 'a video of a blank screen is worse than no video');
});

test('ffmpeg exiting cleanly without writing a file is a failure', async () => {
  const dir = tmp();
  const c = new VideoComposer({ runner: fakeFfmpeg([], { writes: false }), outDir: dir });

  await assert.rejects(c.composeAssets(brief([image(dir, 'a.png')])), (err: unknown) => {
    assert.ok(err instanceof ProviderError);
    assert.match(err.message, /wrote no video/);
    return true;
  });
});

test('the concat list is cleaned up even when ffmpeg fails', async () => {
  const dir = tmp();
  const failing: CliRunner = async () => {
    throw new Error('encoder blew up');
  };
  const c = new VideoComposer({ runner: failing, outDir: dir });

  await assert.rejects(c.composeAssets(brief([image(dir, 'a.png')])));
  assert.equal(
    fs.readdirSync(dir).filter((f) => f.endsWith('.concat.txt')).length,
    0,
    'temp files must not accumulate on every failed render',
  );
});

test('concat list repeats the final still so it is not cut short', () => {
  const list = buildConcatList(['/a.png', '/b.png'], 2.5);
  const lines = list.trim().split('\n');

  assert.deepEqual(lines, [
    "file '/a.png'",
    'duration 2.500',
    "file '/b.png'",
    'duration 2.500',
    "file '/b.png'",
  ]);
});

test('concat list escapes quotes in paths', () => {
  assert.match(buildConcatList(["/it's/a.png"], 1), /it'\\''s/);
});

test('healthCheck reports a missing ffmpeg', async () => {
  const missing: CliRunner = async () => {
    throw new Error('command not found: ffmpeg');
  };
  const h = await new VideoComposer({ runner: missing }).healthCheck();
  assert.equal(h.ok, false);
  assert.match(h.detail!, /not found/);
});

test('passes the composer conformance suite', async () => {
  const c = new VideoComposer({ runner: fakeFfmpeg(), outDir: tmp() });
  const report = await runConformance(c, 'composer');
  assert.ok(report.passed, report.checks.filter((x) => !x.ok).map((x) => `${x.name}: ${x.detail}`).join('\n'));
});
