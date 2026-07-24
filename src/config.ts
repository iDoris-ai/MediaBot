import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Runtime configuration.
 *
 * State lives under ~/.mediabot so a checkout can be moved or re-cloned without
 * losing accounts, drafts or publish history. Overridable via MEDIABOT_HOME for
 * tests and for running several isolated instances.
 */

export interface McpSourceConfig {
  id: string;
  name?: string;
  /** Server command, e.g. "npx". */
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Tool to call for each keyword. */
  tool: string;
  kind?: 'trend' | 'news' | 'competitor';
}

export interface MediaBotConfig {
  home: string;
  dbFile: string;
  outDir: string;
  feeds: string[];
  /** Platforms to monitor by keyword (xiaohongshu | twitter | bilibili). */
  searchPlatforms: string[];
  /** Keywords the monitoring layer watches. */
  keywords: string[];
  /** MCP servers exposed as read-only sources — config, not code. */
  mcpSources: McpSourceConfig[];
  targetPlatforms: string[];
  locale: string;
  style?: string;
  goal?: string;
  /** Generate a cover image locally for each draft. */
  generateImages?: boolean;
  /** Selector profiles for browser-driven platforms; override the templates here. */
  browserProfiles?: Record<string, unknown>;
  notify?: {
    webhookUrl?: string;
    webhookHeaders?: Record<string, string>;
    telegramBotToken?: string;
    telegramChatId?: string;
  };
  port?: number;
  schedule?: { ingest?: string; publish?: string; monitor?: string; briefing?: string };
}

export function home(): string {
  return process.env.MEDIABOT_HOME || path.join(os.homedir(), '.mediabot');
}

export function configPath(): string {
  return path.join(home(), 'config.json');
}

const DEFAULTS: Omit<MediaBotConfig, 'home' | 'dbFile' | 'outDir'> = {
  feeds: [],
  searchPlatforms: [],
  keywords: [],
  mcpSources: [],
  targetPlatforms: ['dryrun'],
  locale: 'zh-CN',
};

export function loadConfig(): MediaBotConfig {
  const base = home();
  const file = configPath();
  let user: Partial<MediaBotConfig> = {};

  if (fs.existsSync(file)) {
    try {
      user = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`config at ${file} is not valid JSON: ${(err as Error).message}`);
    }
  }

  return {
    ...DEFAULTS,
    ...user,
    home: base,
    dbFile: path.join(base, 'mediabot.db'),
    outDir: user.outDir ?? path.join(base, 'out'),
  };
}

export function saveConfig(patch: Partial<MediaBotConfig>): MediaBotConfig {
  const current = loadConfig();
  const next = { ...current, ...patch };
  fs.mkdirSync(home(), { recursive: true });
  // Derived paths are recomputed on load; storing them would let a stale copy
  // silently override MEDIABOT_HOME later.
  const { home: _h, dbFile: _d, ...persist } = next;
  fs.writeFileSync(configPath(), `${JSON.stringify(persist, null, 2)}\n`);
  return next;
}
