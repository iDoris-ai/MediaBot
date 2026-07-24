/**
 * The MediaBot plugin ABI.
 *
 * External providers import from here and from nowhere else inside MediaBot.
 * Treat every export as public API: additive changes are fine, renames and
 * removals are breaking.
 */
export * from './common';
export * from './source';
export * from './composer';
export * from './publisher';
export * from './engagement';

import type { SourceProvider } from './source';
import type { ComposerProvider } from './composer';
import type { PublisherProvider } from './publisher';
import type { EngagementProvider } from './engagement';

/** Any provider, for registry code that handles all slots uniformly. */
export type AnyProvider =
  | SourceProvider
  | ComposerProvider
  | PublisherProvider
  | EngagementProvider;
