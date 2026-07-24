/**
 * Redaction for anything that lands in the audit trail.
 *
 * The `runs` table exists so a human can answer "what did it actually do".
 * The moment it starts recording provider call arguments, it also becomes a
 * place credentials can leak into — a cookie jar, a bot token, a `secret:`
 * value already resolved to its plaintext. An audit log you cannot show anyone
 * is not an audit log.
 *
 * So everything written there passes through here first. The rules are
 * deliberately blunt: match a key that *looks* like a secret and drop the value
 * entirely, rather than trying to recognise valid token formats. False
 * positives cost a redacted debug line; false negatives cost the account.
 *
 * Borrowed from openworker's `coworker/audit.py::_sanitize_args` (MIT,
 * Copyright 2024 Andrew Ng), rewritten for this codebase.
 */

/** Key fragments that mean "this value is a credential". */
const SECRET_KEYS = [
  'token',
  'secret',
  'password',
  'passwd',
  'api_key',
  'apikey',
  'access_key',
  'accesskey',
  'auth',
  'cookie',
  'session',
  'credential',
  'private_key',
  'signature',
];

/**
 * Keys holding post content. Not secret, but a full 6000-character blog post in
 * every run row makes the log unreadable and the database large.
 */
const BODY_KEYS = ['body', 'content', 'html', 'text', 'caption', 'transcript', 'prompt'];

const MAX_STRING = 500;
const MAX_ARRAY = 10;
const MAX_KEYS = 20;

export interface SanitizeOptions {
  /** Per-string cap. */
  maxString?: number;
}

/**
 * Redact and shrink a value for storage.
 *
 * Objects are walked; anything under a secret-looking key becomes
 * `[redacted]` regardless of type, so a nested `{ auth: { token } }` cannot
 * leak through the child.
 */
export function sanitizeArgs(value: unknown, opts: SanitizeOptions = {}): unknown {
  return walk(value, opts.maxString ?? MAX_STRING, 0);
}

function walk(value: unknown, maxString: number, depth: number): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return truncate(redactText(value), maxString);
  if (value instanceof Date) return value.toISOString();

  // Deeply nested structures are almost always raw provider responses; keeping
  // the shape past this point buys nothing an operator can read.
  if (depth >= 4) return '[nested]';

  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ARRAY).map((v) => walk(v, maxString, depth + 1));
    return value.length > MAX_ARRAY ? [...head, `[+${value.length - MAX_ARRAY} more]`] : head;
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [key, v] of entries.slice(0, MAX_KEYS)) {
      const lower = key.toLowerCase();
      if (SECRET_KEYS.some((s) => lower.includes(s))) {
        out[key] = '[redacted]';
      } else if (BODY_KEYS.some((b) => lower === b || lower.endsWith(`_${b}`))) {
        out[key] = summarizeBody(v, maxString);
      } else {
        out[key] = walk(v, maxString, depth + 1);
      }
    }
    if (entries.length > MAX_KEYS) out['…'] = `[+${entries.length - MAX_KEYS} more keys]`;
    return out;
  }

  return truncate(String(value), maxString);
}

/**
 * Content keys keep a short head plus their length.
 *
 * Enough to tell which draft this was without storing the draft twice — the
 * full text already lives in `draft_variants`.
 */
function summarizeBody(value: unknown, maxString: number): unknown {
  if (typeof value !== 'string') return walk(value, maxString, 3);
  const head = value.slice(0, 80).replace(/\s+/g, ' ').trim();
  return `${head}${value.length > 80 ? '…' : ''} [${value.length} chars]`;
}

/**
 * Strip credentials out of free text.
 *
 * Error messages are the leak nobody plans for: a CLI that fails while echoing
 * its own argv, an HTTP client that includes the request URL. Handles the two
 * shapes that actually occur — `key=value` / `key: value` pairs with a
 * secret-looking key, and `Bearer <token>` — plus Telegram's `/bot<token>/`
 * path, which is a URL segment rather than a pair.
 */
export function redactText(text: string): string {
  if (!text) return text;
  let out = text;

  const keyPattern = SECRET_KEYS.map((k) => k.replace('_', '[_-]?')).join('|');
  // The value alternatives include `Bearer <token>` deliberately: matching a
  // bare word first would treat "Bearer" as the whole value of
  // `Authorization: Bearer eyJ…` and leave the token itself in the log.
  out = out.replace(
    new RegExp(
      `\\b((?:${keyPattern})[\\w-]*)\\s*[=:]\\s*("[^"]*"|'[^']*'|(?:bearer|basic)\\s+[^\\s,;"']+|[^\\s,;&"']+)`,
      'gi',
    ),
    '$1=[redacted]',
  );
  out = out.replace(/\b(bearer|basic)\s+[\w.\-+/=]+/gi, '$1 [redacted]');
  // https://api.telegram.org/bot<token>/sendMessage
  out = out.replace(/\/bot\d+:[\w-]+/g, '/bot[redacted]');

  return out;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\r?\n/g, '\\n');
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Convenience: sanitize and serialize in one step, for a TEXT column. */
export function auditJson(value: unknown, opts: SanitizeOptions = {}): string {
  return JSON.stringify(sanitizeArgs(value, opts));
}
