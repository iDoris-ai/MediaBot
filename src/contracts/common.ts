/**
 * Types shared across all four provider slots.
 *
 * Nothing in `src/contracts/` may contain an implementation — these files are
 * the plugin ABI. Third-party providers compile against them, so a breaking
 * change here breaks every external provider.
 */

/** Where a media file lives plus the metadata publishers need to validate it. */
export interface MediaRef {
  kind: 'image' | 'video' | 'audio';
  /** Absolute local path. Remote URLs must be downloaded before publish. */
  path: string;
  mimeType?: string;
  bytes?: number;
  /** Video/audio only. */
  durationSeconds?: number;
  width?: number;
  height?: number;
  /** Video only — cover frame used by platforms that require one. */
  thumbnailPath?: string;
  alt?: string;
}

export type Locale = 'zh-CN' | 'en-US' | (string & {});

/** Result of checking a draft against one platform's rules. */
export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface ValidationIssue {
  /** Machine-readable, e.g. 'text_too_long', 'video_too_long', 'missing_cover'. */
  code: string;
  message: string;
  /** Which field tripped it, e.g. 'body', 'media[0]'. */
  field?: string;
}

/** Every provider declares itself so the registry can route without importing it. */
export interface ProviderInfo {
  id: string;
  slot: ProviderSlot;
  /** Human-readable, shown in the UI. */
  name: string;
  /** Upstream project this wraps, if any — used for the license audit. */
  upstream?: string;
}

export type ProviderSlot = 'source' | 'composer' | 'publisher' | 'engagement';

/**
 * Providers throw these rather than bare Errors so the daemon can decide
 * between retry, re-auth, and dead-lettering without string matching.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: ProviderErrorCode,
    /** Whether the daemon should retry with backoff. */
    readonly retryable: boolean = false,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'ProviderError';
  }
}

export type ProviderErrorCode =
  /** Credentials expired/revoked — account goes to `needs_reauth`, no retry. */
  | 'auth_expired'
  /** Platform rejected the content itself — retrying won't help. */
  | 'rejected'
  /** Rate limited — retry after backoff. */
  | 'rate_limited'
  /** Network/5xx — retry after backoff. */
  | 'transient'
  /** Provider misconfigured (missing binary, bad config) — no retry. */
  | 'misconfigured'
  /** Anything else. */
  | 'unknown';
