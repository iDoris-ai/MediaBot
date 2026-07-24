import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FluxImageComposer, buildImagePrompt } from './flux-image';
import { ChainComposer } from './chain';
import { ClaudeComposer } from './claude';
import { runConformance } from '../../testing/conformance';
import { ProviderError, type ContentBrief } from '../../contracts';
import type { CliRunner } from '../../core/cli-adapter';

/**
 * Image generation takes ~40s on real hardware, so every test drives a stub
 * runner that just writes a file where mflux would have.
 */
function fakeMflux(calls: string[][] = [], writeFile = true): CliRunner {
  return async (_bin, args) => {
    calls.push(args);
    if (writeFile) {
      const out = args[args.indexOf('--output') + 1]!;
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, 'fake-png-bytes');
    }
    return { stdout: 'done', stderr: '' };
  };
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mediabot-flux-'));
}

const brief = (over: Partial<ContentBrief> = {}): ContentBrief => ({
  sources: [],
  targetPlatforms: ['xiaohongshu'],
  locale: 'zh-CN',
  goal: '介绍本地图像生成',
  ...over,
});

function composer(runner: CliRunner, outDir = tmpDir()) {
  // Point at paths that exist so healthCheck passes without the real model.
  return new FluxImageComposer({ runner, outDir, python: __filename, modelPath: __dirname });
}

test('composeAssets generates an image and describes it', async () => {
  const calls: string[][] = [];
  const c = composer(fakeMflux(calls));

  const assets = await c.composeAssets(brief());

  assert.equal(assets.length, 1);
  assert.equal(assets[0]!.kind, 'image');
  assert.equal(assets[0]!.mimeType, 'image/png');
  assert.ok(fs.existsSync(assets[0]!.path));
  assert.equal(assets[0]!.bytes, fs.statSync(assets[0]!.path).size);
  assert.equal(assets[0]!.width, 768, 'fast preset renders 768px');
});

test('the mflux command carries model, preset and seed', async () => {
  const calls: string[][] = [];
  await composer(fakeMflux(calls)).composeAssets(brief());

  const args = calls[0]!;
  assert.equal(args[args.indexOf('--base-model') + 1], 'flux2-klein-4b');
  assert.equal(args[args.indexOf('--steps') + 1], '8');
  assert.equal(args[args.indexOf('--seed') + 1], '42');
  assert.equal(args[args.indexOf('--width') + 1], '768');
  assert.ok(args.includes('--low-ram'));
});

test('quality mode raises steps and resolution', async () => {
  const calls: string[][] = [];
  const c = new FluxImageComposer({
    runner: fakeMflux(calls),
    outDir: tmpDir(),
    mode: 'quality',
    python: __filename,
    modelPath: __dirname,
  });
  await c.composeAssets(brief());

  const args = calls[0]!;
  assert.equal(args[args.indexOf('--steps') + 1], '16');
  assert.equal(args[args.indexOf('--width') + 1], '1024');
});

test('a silent failure that writes no file is reported, not returned as success', async () => {
  const c = composer(fakeMflux([], false));
  await assert.rejects(c.composeAssets(brief()), (err: unknown) => {
    assert.ok(err instanceof ProviderError);
    assert.match(err.message, /wrote no image/);
    return true;
  });
});

test('a brief with nothing to depict generates nothing', async () => {
  const calls: string[][] = [];
  const c = composer(fakeMflux(calls));
  const assets = await c.composeAssets({ sources: [], targetPlatforms: ['x'], locale: 'en-US' });
  assert.deepEqual(assets, []);
  assert.equal(calls.length, 0, 'no subject means no reason to spend 40s of GPU');
});

test('healthCheck reports a missing binary or model', async () => {
  const noBin = new FluxImageComposer({ python: '/nope/mflux', modelPath: __dirname });
  assert.match((await noBin.healthCheck()).detail!, /mflux not found/);

  const noModel = new FluxImageComposer({ python: __filename, modelPath: '/nope/model' });
  assert.match((await noModel.healthCheck()).detail!, /model not found/);

  assert.equal((await composer(fakeMflux()).healthCheck()).ok, true);
});

test('the prompt uses the goal and suppresses text artifacts', () => {
  const p = buildImagePrompt(brief({ goal: '本地图像生成', style: 'minimal flat' }))!;
  assert.match(p, /本地图像生成/);
  assert.match(p, /minimal flat/);
  assert.match(p, /no text/, 'generated covers must not contain garbled lettering');
  assert.equal(buildImagePrompt({ sources: [], targetPlatforms: [], locale: 'en-US' }), null);
});

test('falls back to the first source title when no goal is set', () => {
  const p = buildImagePrompt(
    brief({
      goal: undefined,
      sources: [{ id: 'a:1', providerId: 'a', kind: 'news', title: '某个热点' }],
    }),
  )!;
  assert.match(p, /某个热点/);
});

test('passes the composer conformance suite', async () => {
  const report = await runConformance(composer(fakeMflux()), 'composer');
  assert.ok(report.passed, report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('\n'));
});

test('chain attaches generated images to the text composer output', async () => {
  const image = composer(fakeMflux());
  const text = new ClaudeComposer({
    runner: async () => ({
      text: '```json\n{"variants":[{"platform":"xiaohongshu","title":"标题","body":"正文"}]}\n```',
      transcript: '',
    }),
  });

  const draft = await new ChainComposer({ assetProviders: [image], textComposer: text }).compose(brief());

  assert.equal(draft.variants.length, 1);
  assert.equal(draft.variants[0]!.body, '正文');
  assert.equal(draft.variants[0]!.media.length, 1, 'the generated cover rides along');
  assert.ok(fs.existsSync(draft.variants[0]!.media[0]!.path));
});

test('a failed cover degrades to a text-only post instead of losing it', async () => {
  const failures: string[] = [];
  const broken = composer(fakeMflux([], false));
  const text = new ClaudeComposer({
    runner: async () => ({
      text: '```json\n{"variants":[{"platform":"xiaohongshu","body":"正文还在"}]}\n```',
      transcript: '',
    }),
  });

  const draft = await new ChainComposer({
    assetProviders: [broken],
    textComposer: text,
    onAssetError: (id) => failures.push(id),
  }).compose(brief());

  assert.deepEqual(failures, ['flux-image']);
  assert.equal(draft.variants[0]!.body, '正文还在');
  assert.deepEqual(draft.variants[0]!.media, []);
});

test('chain health is degraded, not failed, when only an asset provider is down', async () => {
  const brokenImage = new FluxImageComposer({ python: '/nope', modelPath: '/nope' });
  const text = new ClaudeComposer({ runner: async () => ({ text: '', transcript: '' }) });
  const chain = new ChainComposer({ assetProviders: [brokenImage], textComposer: text });

  const h = await chain.healthCheck();
  assert.equal(h.ok, true, 'losing covers must not take the whole composer offline');
  assert.match(h.detail!, /degraded/);
});

test('pre-existing brief assets survive alongside generated ones', async () => {
  const existing = path.join(tmpDir(), 'mine.png');
  fs.writeFileSync(existing, 'x');

  const text = new ClaudeComposer({
    runner: async () => ({
      text: '```json\n{"variants":[{"platform":"xiaohongshu","body":"b"}]}\n```',
      transcript: '',
    }),
  });
  const draft = await new ChainComposer({
    assetProviders: [composer(fakeMflux())],
    textComposer: text,
  }).compose(brief({ assets: [{ kind: 'image', path: existing }] }));

  assert.equal(draft.variants[0]!.media.length, 2);
});
