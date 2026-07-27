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

  /** Is the stored credential still usable? */
  checkAuth(): Promise<AuthState>;

  /** Pure check against `limits` and platform rules. Must not perform I/O writes. */
  validate(variant: DraftVariant): Promise<ValidationResult>;

  publish(variant: DraftVariant, options: PublishOptions): Promise<PublishResult>;
}

export type PublishTransport = 'api' | 'cli' | 'browser' | 'extension' | 'file';

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
