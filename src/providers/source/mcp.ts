import { createHash } from 'crypto';
import type {
  ProviderInfo,
  SourceItem,
  SourceKind,
  SourceProvider,
  SourceQuery,
} from '../../contracts';
import { McpClient, type McpServerConfig } from '../../core/mcp';

/**
 * Wraps any MCP server tool as a read-only source.
 *
 * This is the "config, not code" path for the monitoring layer: pointing at a
 * Google Trends or competitor-intel MCP server needs a config entry, not a new
 * provider. The tool's text output is parsed leniently — JSON when it is JSON,
 * lines otherwise — because MCP servers vary widely in what they return.
 */

export interface McpSourceOptions {
  id: string;
  name?: string;
  kind?: SourceKind;
  server: McpServerConfig;
  /** Tool to call. */
  tool: string;
  /**
   * Build the tool arguments from a query. Defaults to `{ query, limit }`,
   * which covers most search-shaped tools.
   */
  buildArgs?: (query: SourceQuery, keyword: string) => Record<string, unknown>;
  keywords?: string[];
  client?: McpClient;
}

export class McpSource implements SourceProvider {
  readonly info: ProviderInfo;
  readonly kind: SourceKind;

  private readonly client: McpClient;
  private readonly tool: string;
  private readonly buildArgs: (query: SourceQuery, keyword: string) => Record<string, unknown>;
  private readonly defaultKeywords: string[];

  constructor(opts: McpSourceOptions) {
    this.info = {
      id: opts.id,
      slot: 'source',
      name: opts.name ?? `MCP: ${opts.tool}`,
      upstream: opts.server.command,
    };
    this.kind = opts.kind ?? 'trend';
    this.client = opts.client ?? new McpClient(opts.server);
    this.tool = opts.tool;
    this.buildArgs =
      opts.buildArgs ?? ((query, keyword) => ({ query: keyword, limit: query.limit ?? 10 }));
    this.defaultKeywords = opts.keywords ?? [];
  }

  async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    try {
      const tools = await this.client.listTools();
      const found = tools.some((t) => t.name === this.tool);
      return found
        ? { ok: true }
        : { ok: false, detail: `server has no tool "${this.tool}" (has: ${tools.map((t) => t.name).join(', ')})` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : 'MCP server unreachable' };
    }
  }

  async fetch(query: SourceQuery = {}): Promise<SourceItem[]> {
    const keywords = query.keywords?.length ? query.keywords : this.defaultKeywords;
    if (keywords.length === 0) return [];

    const seen = new Set<string>();
    const out: SourceItem[] = [];

    for (const keyword of keywords) {
      let text: string;
      try {
        text = await this.client.callTool(this.tool, this.buildArgs(query, keyword));
      } catch {
        // One failing keyword must not cost the others.
        continue;
      }

      for (const parsed of parseToolOutput(text)) {
        const id = `${this.info.id}:${parsed.externalId}`;
        if (seen.has(id)) continue;
        if (query.since && parsed.publishedAt && parsed.publishedAt < query.since) continue;
        seen.add(id);

        out.push({
          id,
          providerId: this.info.id,
          kind: this.kind,
          title: parsed.title,
          ...(parsed.url ? { url: parsed.url } : {}),
          ...(parsed.summary ? { summary: parsed.summary } : {}),
          ...(parsed.score !== undefined ? { score: parsed.score } : {}),
          ...(parsed.publishedAt ? { publishedAt: parsed.publishedAt } : {}),
          ...(query.locale ? { locale: query.locale } : {}),
          raw: parsed.raw,
        });
      }
    }

    return typeof query.limit === 'number' ? out.slice(0, query.limit) : out;
  }

  close(): void {
    this.client.close();
  }
}

interface ParsedRow {
  externalId: string;
  title: string;
  url?: string;
  summary?: string;
  score?: number;
  publishedAt?: Date;
  raw: unknown;
}

/**
 * Parse whatever a tool returned.
 *
 * Tries JSON (array, or an object wrapping an array) and falls back to treating
 * each non-empty line as a title. Ids are derived from a stable field when one
 * exists and hashed from the content otherwise — an unstable id would duplicate
 * a row on every poll.
 */
export function parseToolOutput(text: string): ParsedRow[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const json = tryJson(trimmed);
  if (json !== undefined) {
    const rows = Array.isArray(json)
      ? json
      : (['items', 'results', 'data', 'trends', 'entries'] as const)
          .map((k) => (json as any)?.[k])
          .find(Array.isArray);

    if (Array.isArray(rows)) {
      return rows.map((row) => mapRow(row)).filter((r): r is ParsedRow => r !== null);
    }
  }

  return trimmed
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => ({ externalId: hash(line), title: line, raw: line }));
}

function mapRow(row: any): ParsedRow | null {
  if (typeof row === 'string') {
    return row.trim() ? { externalId: hash(row), title: row.trim(), raw: row } : null;
  }
  if (!row || typeof row !== 'object') return null;

  const title = row.title ?? row.name ?? row.query ?? row.keyword ?? row.topic ?? row.text;
  if (typeof title !== 'string' || !title.trim()) return null;

  const url = typeof row.url === 'string' ? row.url : typeof row.link === 'string' ? row.link : undefined;
  const summary =
    typeof row.summary === 'string'
      ? row.summary
      : typeof row.description === 'string'
        ? row.description
        : undefined;

  const rawScore = row.score ?? row.value ?? row.volume ?? row.interest ?? row.traffic;
  const score = Number(rawScore);

  const rawDate = row.publishedAt ?? row.published_at ?? row.date ?? row.time;
  const published = rawDate ? new Date(rawDate) : undefined;

  return {
    // Prefer a server-provided id; hash the title only as a last resort.
    externalId: String(row.id ?? row.uid ?? url ?? hash(title)),
    title: title.trim(),
    ...(url ? { url } : {}),
    ...(summary ? { summary } : {}),
    ...(Number.isFinite(score) ? { score } : {}),
    ...(published && !Number.isNaN(published.getTime()) ? { publishedAt: published } : {}),
    raw: row,
  };
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function hash(s: string): string {
  return createHash('sha1').update(s, 'utf8').digest('hex').slice(0, 16);
}
