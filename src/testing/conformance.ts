import type {
  AnyProvider,
  ComposerProvider,
  EngagementProvider,
  ProviderSlot,
  PublisherProvider,
  SourceProvider,
} from '../contracts';

/**
 * Contract conformance kit.
 *
 * Providers are pluggable, so without a shared conformance suite the ecosystem
 * drifts into implementations that satisfy the TypeScript types but behave
 * inconsistently at runtime. Any third-party provider runs this to self-certify:
 *
 *   pnpm test:conformance --provider ./my-provider.ts --slot publisher
 *
 * Checks are behavioural, not just structural — they call the provider with
 * probe inputs and assert on what comes back.
 */

export interface ConformanceCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ConformanceReport {
  providerId: string;
  slot: ProviderSlot;
  checks: ConformanceCheck[];
  passed: boolean;
}

/** Names of write-ish methods a read-only provider must not expose. */
const WRITE_METHODS = ['publish', 'reply', 'post', 'send', 'comment'];

export async function runConformance(
  provider: AnyProvider,
  slot: ProviderSlot,
): Promise<ConformanceReport> {
  const checks: ConformanceCheck[] = [];
  const check = async (name: string, fn: () => Promise<void> | void) => {
    try {
      await fn();
      checks.push({ name, ok: true });
    } catch (err) {
      checks.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  };

  await check('declares provider info', () => {
    const info = (provider as any).info;
    assert(info && typeof info === 'object', 'provider.info missing');
    assert(typeof info.id === 'string' && info.id.length > 0, 'info.id must be a non-empty string');
    assert(info.slot === slot, `info.slot is "${info.slot}", expected "${slot}"`);
    assert(typeof info.name === 'string' && info.name.length > 0, 'info.name required');
  });

  switch (slot) {
    case 'source':
      await checkSource(provider as SourceProvider, check);
      break;
    case 'composer':
      await checkComposer(provider as ComposerProvider, check);
      break;
    case 'publisher':
      await checkPublisher(provider as PublisherProvider, check);
      break;
    case 'engagement':
      await checkEngagement(provider as EngagementProvider, check);
      break;
  }

  return {
    providerId: (provider as any)?.info?.id ?? '<unknown>',
    slot,
    checks,
    passed: checks.every((c) => c.ok),
  };
}

type Check = (name: string, fn: () => Promise<void> | void) => Promise<void>;

async function checkSource(p: SourceProvider, check: Check): Promise<void> {
  await check('declares a valid kind', () => {
    assert(
      ['trend', 'news', 'competitor', 'comment'].includes(p.kind),
      `unknown source kind: ${p.kind}`,
    );
  });

  await check('healthCheck resolves with an ok flag', async () => {
    const h = await p.healthCheck();
    assert(typeof h?.ok === 'boolean', 'healthCheck must resolve to { ok: boolean }');
  });

  await check('fetch returns an array', async () => {
    const items = await p.fetch({ limit: 3 });
    assert(Array.isArray(items), 'fetch must resolve to an array');
  });

  await check('item ids are namespaced as "<providerId>:<externalId>"', async () => {
    const items = await p.fetch({ limit: 5 });
    for (const it of items) {
      assert(typeof it.id === 'string' && it.id.includes(':'), `bad item id: ${it.id}`);
      assert(
        it.id.startsWith(`${p.info.id}:`),
        `item id "${it.id}" must be prefixed with "${p.info.id}:" — this is the primary key that makes re-polling idempotent`,
      );
      assert(typeof it.title === 'string' && it.title.length > 0, 'item.title required');
      assert(it.providerId === p.info.id, 'item.providerId must match info.id');
    }
  });

  await check('ids are stable across repeated fetches (idempotent polling)', async () => {
    const a = await p.fetch({ limit: 5 });
    const b = await p.fetch({ limit: 5 });
    if (a.length === 0 || b.length === 0) return; // Nothing to compare.
    const idsA = new Set(a.map((i) => i.id));
    const overlap = b.filter((i) => idsA.has(i.id)).length;
    assert(
      overlap > 0,
      'two consecutive fetches shared no ids — ids are probably random per call, which would duplicate rows on every poll',
    );
  });

  await check('respects the limit argument', async () => {
    const items = await p.fetch({ limit: 2 });
    assert(items.length <= 2, `asked for 2 items, got ${items.length}`);
  });

  await check('is read-only ("eyes, not hands")', () => {
    for (const m of WRITE_METHODS) {
      assert(
        typeof (p as any)[m] !== 'function',
        `SourceProvider must not expose a write method, found "${m}()" — monitoring may never publish directly`,
      );
    }
  });
}

async function checkComposer(p: ComposerProvider, check: Check): Promise<void> {
  await check('declares what it produces', () => {
    assert(Array.isArray(p.produces) && p.produces.length > 0, 'produces must be non-empty');
    for (const k of p.produces) {
      assert(['text', 'image', 'video', 'audio'].includes(k), `unknown content kind: ${k}`);
    }
  });

  await check('healthCheck resolves with an ok flag', async () => {
    const h = await p.healthCheck();
    assert(typeof h?.ok === 'boolean', 'healthCheck must resolve to { ok: boolean }');
  });

  await check('compose returns a draft with well-formed variants', async () => {
    const draft = await p.compose({
      sources: [],
      targetPlatforms: ['conformance-probe'],
      locale: 'en-US',
      style: 'plain',
    });
    assert(draft && typeof draft.id === 'string', 'draft.id required');
    assert(Array.isArray(draft.variants), 'draft.variants must be an array');
    for (const v of draft.variants) {
      assert(typeof v.id === 'string' && v.id.length > 0, 'variant.id required');
      assert(typeof v.platform === 'string' && v.platform.length > 0, 'variant.platform required');
      assert(typeof v.body === 'string', 'variant.body must be a string');
      assert(Array.isArray(v.media), 'variant.media must be an array (empty is fine)');
    }
  });

  await check('emits variants only for requested platforms', async () => {
    const draft = await p.compose({
      sources: [],
      targetPlatforms: ['conformance-probe'],
      locale: 'en-US',
    });
    for (const v of draft.variants) {
      assert(
        v.platform === 'conformance-probe',
        `composed for "${v.platform}" which was not in targetPlatforms`,
      );
    }
  });
}

async function checkPublisher(p: PublisherProvider, check: Check): Promise<void> {
  await check('declares platform and transport', () => {
    assert(typeof p.platform === 'string' && p.platform.length > 0, 'platform required');
    assert(
      ['api', 'browser', 'extension'].includes(p.transport),
      `unknown transport: ${p.transport}`,
    );
  });

  await check('declares usable limits', () => {
    const l = p.limits;
    assert(l && typeof l === 'object', 'limits required');
    assert(
      Number.isFinite(l.maxTextLength) && l.maxTextLength > 0,
      'limits.maxTextLength must be a positive number',
    );
    assert(typeof l.supportsScheduling === 'boolean', 'limits.supportsScheduling required');
    if (l.video) {
      assert(l.video.maxSeconds > 0, 'limits.video.maxSeconds must be positive');
      assert(l.video.maxBytes > 0, 'limits.video.maxBytes must be positive');
      assert(Array.isArray(l.video.formats) && l.video.formats.length > 0, 'limits.video.formats required');
    }
  });

  await check('checkAuth resolves with an ok flag', async () => {
    const a = await p.checkAuth();
    assert(typeof a?.ok === 'boolean', 'checkAuth must resolve to { ok: boolean }');
  });

  await check('validate accepts a compliant variant', async () => {
    const r = await p.validate(probeVariant(p, 'ok'));
    assert(r && typeof r.ok === 'boolean', 'validate must resolve to a ValidationResult');
    assert(Array.isArray(r.errors) && Array.isArray(r.warnings), 'errors/warnings must be arrays');
    assert(r.ok, `a compliant variant was rejected: ${JSON.stringify(r.errors)}`);
  });

  await check('validate enforces its own declared maxTextLength', async () => {
    const r = await p.validate(probeVariant(p, 'too-long'));
    assert(
      !r.ok,
      `body exceeding the declared maxTextLength (${p.limits.maxTextLength}) was accepted — limits must match real behaviour`,
    );
    assert(r.errors.length > 0, 'a failed validation must explain why');
    for (const e of r.errors) {
      assert(typeof e.code === 'string' && e.code.length > 0, 'ValidationIssue.code required');
    }
  });

  await check('validate does not mutate the variant it is given', async () => {
    const v = probeVariant(p, 'ok');
    const before = JSON.stringify(v);
    await p.validate(v);
    assert(JSON.stringify(v) === before, 'validate must be side-effect free');
  });

  await check('dry-run publish returns a well-formed result', async () => {
    const res = await p.publish(probeVariant(p, 'ok'), {
      accountId: 'conformance-account',
      dryRun: true,
    });
    assert(
      typeof res?.platformPostId === 'string' && res.platformPostId.length > 0,
      'publish must return a platformPostId — it anchors later comment polling',
    );
    assert(res.publishedAt instanceof Date, 'publish must return publishedAt as a Date');
  });
}

async function checkEngagement(p: EngagementProvider, check: Check): Promise<void> {
  await check('declares a platform', () => {
    assert(typeof p.platform === 'string' && p.platform.length > 0, 'platform required');
  });

  await check('listComments returns an array of namespaced comments', async () => {
    const comments = await p.listComments({
      postId: 'probe',
      platformPostId: 'probe',
      accountId: 'conformance-account',
    });
    assert(Array.isArray(comments), 'listComments must resolve to an array');
    for (const c of comments) {
      assert(
        typeof c.id === 'string' && c.id.startsWith(`${p.platform}:`),
        `comment id "${c.id}" must be prefixed with "${p.platform}:" for idempotent polling`,
      );
    }
  });
}

function probeVariant(p: PublisherProvider, mode: 'ok' | 'too-long') {
  const body = mode === 'ok' ? 'conformance probe' : 'x'.repeat(p.limits.maxTextLength + 1);
  return {
    id: 'dv_conformance_probe',
    platform: p.platform,
    title: 'Conformance probe',
    body,
    media: [],
  };
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

/** Render a report as human-readable lines. */
export function formatReport(report: ConformanceReport): string {
  const lines = [`${report.passed ? 'PASS' : 'FAIL'}  ${report.slot}:${report.providerId}`];
  for (const c of report.checks) {
    lines.push(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? `\n      ${c.detail}` : ''}`);
  }
  return lines.join('\n');
}
