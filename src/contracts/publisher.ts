import type { ProviderInfo, ValidationResult } from './common';
import type { DraftVariant } from './composer';

/**
 * Publishes a variant to one platform.
 *
 * INVARIANT: `publish()` is only ever called by the executor, after an approval
 * has been granted AND its payload hash re-verified. Providers must not
 * self-schedule or publish from any other method.
 */
export interface PublisherProvider {
  readonly info: ProviderInfo;
  readonly platform: string;
  /**
   * How this provider reaches the platform. Determines what the runtime needs:
   *   api       — plain HTTP, no browser
   *   cli       — an external command-line tool run as a subprocess
   *   browser   — Playwright + persisted cookies (first login needs a GUI)
   *   extension — routed through the MultiPost browser extension
   *   file      — written into a local repository and committed
   */
  readonly transport: PublishTransport;
  readonly limits: PlatformLimits;

  /**
   * How far a publish through this provider can be taken back.
   *
   * Read by the approval gate to decide whether this action may be covered by a
   * standing rule. Omitting it means `irreversible` — a provider that has not
   * thought about the question is treated as the dangerous case.
   */
  readonly consequence?: Consequence;

  /**
   * The exact thing this publish acts on — a repository path, an account id, an
   * output directory. Providers that can name one become eligible for standing
   * rules bound to that value; providers that cannot never do.
   *
   * It must identify the destination, not the provider: a rule granted against
   * `/Users/me/blog#src/content/blog` must stop applying if the config is
   * repointed at another repository.
   *
   * Callable with no variant — the CLI lists and grants targets before any
   * draft exists — so the destination must not depend on the content.
   */
  targetFor?(variant?: DraftVariant): string | undefined;

  /** Is the stored credential still usable? */
  checkAuth(): Promise<AuthState>;

  /** Pure check against `limits` and platform rules. Must not perform I/O writes. */
  validate(variant: DraftVariant): Promise<ValidationResult>;

  publish(variant: DraftVariant, options: PublishOptions): Promise<PublishResult>;
}

export type PublishTransport = 'api' | 'cli' | 'browser' | 'extension' | 'file';

/**
 * How reversible an action is — the axis the approval gate cares about.
 *
 *   local        — writes only to this machine (dry-run output)
 *   reversible   — git-backed; undoing it is a revert
 *   draft_only   — creates a draft a human still has to send on the platform
 *   irreversible — public the moment it lands, and cannot be unsent
 */
export type Consequence = 'local' | 'reversible' | 'draft_only' | 'irreversible';

export interface AuthState {
  ok: boolean;
  /** Present when ok is false — surfaced in the UI to prompt re-login. */
  reason?: string;
  expiresAt?: Date;
}

export interface PlatformLimits {
  maxTextLength: number;
  maxTitleLength?: number;
  maxImages?: number;
  video?: {
    maxSeconds: number;
    maxBytes: number;
    /** Container formats, lowercase without dot: ['mp4', 'mov']. */
    formats: string[];
  };
  /**
   * True when the platform itself can hold a post until a future time.
   * When false the daemon fires at the scheduled moment instead.
   */
  supportsScheduling: boolean;
}

export interface PublishOptions {
  accountId: string;
  /** Honoured natively when `limits.supportsScheduling`, else already due. */
  scheduledFor?: Date;
  /** Go through every step except the final irreversible submit. */
  dryRun?: boolean;
}

export interface PublishResult {
  /** The platform's own id — the anchor for later comment polling. */
  platformPostId: string;
  url?: string;
  publishedAt: Date;
}
