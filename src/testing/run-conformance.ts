#!/usr/bin/env node
import path from 'path';
import { formatReport, runConformance, type ConformanceReport } from './conformance';
import type { AnyProvider, ProviderSlot } from '../contracts';

/**
 * Certify a provider against the contract suite.
 *
 *   pnpm test:conformance                                  # built-in providers
 *   pnpm test:conformance --provider ./mine.ts --slot publisher
 *
 * The module must default-export either a provider instance or a zero-argument
 * factory returning one.
 */

const SLOTS: ProviderSlot[] = ['source', 'composer', 'publisher', 'engagement'];

async function main(argv: string[]): Promise<number> {
  const providerPath = valueOf(argv, '--provider');
  const slot = valueOf(argv, '--slot') as ProviderSlot | undefined;

  const reports: ConformanceReport[] = providerPath
    ? [await certifyExternal(providerPath, slot)]
    : await certifyBuiltIns();

  for (const r of reports) process.stdout.write(`${formatReport(r)}\n\n`);

  const failed = reports.filter((r) => !r.passed);
  if (failed.length) {
    process.stderr.write(`${failed.length} of ${reports.length} provider(s) failed conformance\n`);
    return 1;
  }
  process.stdout.write(`all ${reports.length} provider(s) conform\n`);
  return 0;
}

async function certifyExternal(modulePath: string, slot?: ProviderSlot): Promise<ConformanceReport> {
  if (!slot || !SLOTS.includes(slot)) {
    throw new Error(`--slot is required and must be one of: ${SLOTS.join(', ')}`);
  }
  const mod = require(path.resolve(modulePath));
  const exported = mod.default ?? mod;
  const provider: AnyProvider = typeof exported === 'function' ? exported() : exported;
  return runConformance(provider, slot);
}

/** Smoke-certify the bundled providers so CI catches contract regressions. */
async function certifyBuiltIns(): Promise<ConformanceReport[]> {
  const { RssSourceProvider } = require('../providers/source/rss');
  const { ClaudeComposer } = require('../providers/composer/claude');
  const { DryRunPublisher } = require('../providers/publisher/dryrun');
  const os = require('os');
  const fs = require('fs');

  const feed = `<rss><channel><item><title>probe</title><guid>p-1</guid></item></channel></rss>`;
  const stubFetch = async () => new Response(feed, { status: 200 });

  return [
    await runConformance(
      new RssSourceProvider({ feeds: ['https://example.com/f'], fetchImpl: stubFetch }),
      'source',
    ),
    await runConformance(
      new ClaudeComposer({
        runner: async () => ({
          text: '```json\n{"variants":[{"platform":"conformance-probe","body":"probe"}]}\n```',
          transcript: '',
        }),
      }),
      'composer',
    ),
    await runConformance(
      new DryRunPublisher({ outDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mediabot-conf-')) }),
      'publisher',
    ),
  ];
}

function valueOf(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
