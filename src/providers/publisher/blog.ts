import fs from 'fs';
import path from 'path';
import type {
  AuthState,
  DraftVariant,
  PlatformLimits,
  ProviderInfo,
  PublishOptions,
  PublishResult,
  PublisherProvider,
  PublishTransport,
  ValidationIssue,
  ValidationResult,
} from '../../contracts';
import { ProviderError } from '../../contracts';
import { defaultCliRunner, type CliRunner } from '../../core/cli-adapter';

/**
 * Publishes to a static-site repository by writing a markdown file and
 * committing it.
 *
 * This is the only channel allowed to complete unattended after approval, and
 * the reason is specific rather than convenient: git is revertible. A wrong
 * blog post is `git revert` plus a rebuild; a wrong XiaoHongShu post is
 * permanent. The approval gate still guards the content — this just means
 * nothing after it needs a second human step.
 *
 * The frontmatter is validated against the collection's own schema before
 * anything is written, because an out-of-enum `category` does not fail the
 * post — it fails the *site build*, taking every other article down with it.
 */

export interface BlogCollectionSchema {
  /** Fields the collection requires. */
  required: string[];
  /** Fields constrained to a fixed set, e.g. category. */
  enums?: Record<string, string[]>;
  /** Applied when the draft does not supply the field. */
  defaults?: Record<string, unknown>;
}

export interface BlogPublisherOptions {
  /** Platform name, e.g. 'blog-tech' or 'blog-life'. */
  platform: string;
  /** Absolute path to the site repository. */
  repo: string;
  /** Directory holding the collection, relative to the repo. */
  contentDir: string;
  schema: BlogCollectionSchema;
  /** Turned into the published URL, with {slug} substituted. */
  urlPattern?: string;
  /** Commit and push after writing. */
  commit?: boolean;
  push?: boolean;
  runner?: CliRunner;
  timeoutMs?: number;
  now?: () => Date;
}

/** The two collections in the mycelium/blog repo, as defined by its schema. */
export const BLOG_SCHEMAS: Record<string, BlogCollectionSchema> = {
  blog: {
    required: ['title', 'description', 'pubDate'],
    enums: {
      category: ['Tech-Experiment', 'Progress-Report', 'Research', 'Tech-News', 'DN'],
    },
    defaults: { category: 'Research', tags: [] },
  },
  my: {
    required: ['title', 'description', 'pubDate'],
    enums: {
      category: ['Hardware', 'Research', 'Launch', 'Lessons', 'Thought'],
    },
    defaults: { category: 'Lessons', tags: [] },
  },
};

export class BlogPublisher implements PublisherProvider {
  readonly info: ProviderInfo;
  readonly platform: string;
  readonly transport: PublishTransport = 'file';
  readonly limits: PlatformLimits = {
    // Long-form is the point; this is a sanity bound, not a platform cap.
    maxTextLength: 200_000,
    maxTitleLength: 200,
    supportsScheduling: false,
  };

  private readonly repo: string;
  private readonly contentDir: string;
  private readonly schema: BlogCollectionSchema;
  private readonly urlPattern: string | undefined;
  private readonly shouldCommit: boolean;
  private readonly shouldPush: boolean;
  private readonly runner: CliRunner;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(opts: BlogPublisherOptions) {
    this.platform = opts.platform;
    this.info = { id: `blog:${opts.platform}`, slot: 'publisher', name: `Blog (${opts.platform})` };
    this.repo = opts.repo;
    this.contentDir = opts.contentDir;
    this.schema = opts.schema;
    this.urlPattern = opts.urlPattern;
    this.shouldCommit = opts.commit ?? true;
    this.shouldPush = opts.push ?? true;
    this.runner = opts.runner ?? defaultCliRunner;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.now = opts.now ?? (() => new Date());
  }

  private get contentPath(): string {
    return path.join(this.repo, this.contentDir);
  }

  async checkAuth(): Promise<AuthState> {
    if (!fs.existsSync(this.repo)) {
      return { ok: false, reason: `repository not found: ${this.repo}` };
    }
    if (!fs.existsSync(path.join(this.repo, '.git'))) {
      return { ok: false, reason: `${this.repo} is not a git repository` };
    }
    if (!fs.existsSync(this.contentPath)) {
      return { ok: false, reason: `content directory not found: ${this.contentPath}` };
    }
    return { ok: true };
  }

  async validate(variant: DraftVariant): Promise<ValidationResult> {
    const errors: ValidationIssue[] = [];
    const warnings: ValidationIssue[] = [];

    if (!variant.title || !variant.title.trim()) {
      errors.push({ code: 'title_required', field: 'title', message: 'an article needs a title' });
    }
    if (!variant.body.trim()) {
      errors.push({ code: 'empty_body', field: 'body', message: 'article body is empty' });
    } else if (variant.body.length > this.limits.maxTextLength) {
      errors.push({
        code: 'text_too_long',
        field: 'body',
        message: `body is ${variant.body.length} chars, limit is ${this.limits.maxTextLength}`,
      });
    }
    if (variant.title && variant.title.length > this.limits.maxTitleLength!) {
      errors.push({
        code: 'title_too_long',
        field: 'title',
        message: `title is ${variant.title.length} chars, limit is ${this.limits.maxTitleLength}`,
      });
    }

    const meta = (variant.meta ?? {}) as Record<string, unknown>;
    const frontmatter = this.buildFrontmatter(variant, meta);

    for (const field of this.schema.required) {
      if (frontmatter[field] === undefined || frontmatter[field] === '') {
        errors.push({
          code: 'missing_frontmatter',
          field,
          message: `the ${this.platform} collection requires "${field}"`,
        });
      }
    }

    // An out-of-enum value does not fail this post — it fails the site build.
    for (const [field, allowed] of Object.entries(this.schema.enums ?? {})) {
      const value = frontmatter[field];
      if (value !== undefined && !allowed.includes(String(value))) {
        errors.push({
          code: 'invalid_enum',
          field,
          message: `"${value}" is not a valid ${field}; the site build would fail. Allowed: ${allowed.join(', ')}`,
        });
      }
    }

    const slug = this.slugOf(variant, meta);
    if (!slug) {
      errors.push({ code: 'slug_unresolvable', field: 'title', message: 'cannot derive a slug' });
    } else if (fs.existsSync(this.filePathFor(slug))) {
      // Overwriting silently would destroy a published article.
      errors.push({
        code: 'slug_exists',
        message: `${slug}.md already exists — choose another slug or edit the existing article`,
      });
    }

    if (!frontmatter['heroImage'] && variant.media.some((m) => m.kind === 'image')) {
      warnings.push({
        code: 'image_not_hero',
        message: 'images are attached but no heroImage is set; they will not appear as the cover',
      });
    }

    return { ok: errors.length === 0, errors, warnings };
  }

  async publish(variant: DraftVariant, options: PublishOptions): Promise<PublishResult> {
    const meta = (variant.meta ?? {}) as Record<string, unknown>;
    const slug = this.slugOf(variant, meta);
    if (!slug) throw new ProviderError('cannot derive a slug for this article', 'rejected', false);

    const file = this.filePathFor(slug);
    const relative = path.relative(this.repo, file);
    const publishedAt = this.now();

    if (options.dryRun) {
      return { platformPostId: `dryrun_${slug}`, publishedAt };
    }

    if (fs.existsSync(file)) {
      throw new ProviderError(
        `${relative} already exists — refusing to overwrite a published article`,
        'rejected',
        false,
      );
    }

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, renderMarkdown(this.buildFrontmatter(variant, meta), variant.body));

    if (this.shouldCommit) {
      try {
        await this.git(['add', relative]);
        await this.git(['commit', '-m', `post: ${variant.title ?? slug}`]);
        if (this.shouldPush) await this.git(['push']);
      } catch (err) {
        // The file is written; a failed push is recoverable by hand, and
        // deleting the article to "clean up" would lose the content.
        throw new ProviderError(
          `article written to ${relative} but git failed: ${err instanceof Error ? err.message : String(err)}`,
          'transient',
          true,
          err,
        );
      }
    }

    return {
      platformPostId: slug,
      ...(this.urlPattern ? { url: this.urlPattern.replace('{slug}', slug) } : {}),
      publishedAt,
    };
  }

  private git(args: string[]): Promise<unknown> {
    return this.runner('git', ['-C', this.repo, ...args], { timeoutMs: this.timeoutMs });
  }

  private filePathFor(slug: string): string {
    return path.join(this.contentPath, `${slug}.md`);
  }

  private slugOf(variant: DraftVariant, meta: Record<string, unknown>): string | null {
    const explicit = meta['slug'];
    if (typeof explicit === 'string' && explicit.trim()) return slugify(explicit);
    return variant.title ? slugify(variant.title) : null;
  }

  private buildFrontmatter(
    variant: DraftVariant,
    meta: Record<string, unknown>,
  ): Record<string, unknown> {
    const supplied = (meta['frontmatter'] ?? {}) as Record<string, unknown>;
    const cover = variant.media.find((m) => m.kind === 'image');

    return {
      ...this.schema.defaults,
      title: variant.title ?? '',
      description: (meta['description'] as string) ?? firstParagraph(variant.body),
      pubDate: formatDate(this.now()),
      ...(cover && !supplied['heroImage'] ? {} : {}),
      // Anything the draft supplies wins, including overriding the defaults.
      ...supplied,
    };
  }
}

/** Frontmatter keys are plain identifiers; anything else is an injection. */
const SAFE_FRONTMATTER_KEY = /^[A-Za-z0-9_-]+$/;

/** YAML frontmatter plus body. */
export function renderMarkdown(frontmatter: Record<string, unknown>, body: string): string {
  const lines = Object.entries(frontmatter)
    .filter(([, v]) => v !== undefined && v !== null)
    // Values are escaped by renderYamlValue, but keys are interpolated raw. A
    // composer-supplied key containing a newline (frontmatter comes partly from
    // the model via meta.frontmatter) could open a new YAML line or close the
    // block early — and the approval UI shows only title + body, never the
    // frontmatter object, so a human could not catch it. Real keys are always
    // simple identifiers, so drop anything else rather than emit it.
    .filter(([k]) => SAFE_FRONTMATTER_KEY.test(k))
    .map(([k, v]) => `${k}: ${renderYamlValue(v)}`);
  return `---\n${lines.join('\n')}\n---\n\n${body.trim()}\n`;
}

function renderYamlValue(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => JSON.stringify(String(x))).join(', ')}]`;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(String(v));
}

/**
 * URL-safe slug.
 *
 * CJK titles have no ASCII to keep, so they fall back to a transliteration-free
 * scheme: strip punctuation and join what remains. A CJK slug is valid in a URL
 * and stays readable, which beats a hash.
 */
export function slugify(text: string): string {
  const cleaned = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned.slice(0, 80);
}

function firstParagraph(body: string, max = 200): string {
  const text = body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#') && !l.startsWith('>'));
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
