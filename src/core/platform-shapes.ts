/**
 * What each platform's content actually looks like.
 *
 * The same facts read completely differently on XiaoHongShu and a technical
 * blog, and a post that ignores the difference reads as syndicated filler on
 * every platform at once. This is the guidance that goes into the composer
 * prompt, plus the machinery to catch it when the model ignores it anyway —
 * saying "make them different" in a prompt is a request, not a guarantee.
 */

export interface PlatformShape {
  /** Rough target length in characters, used as guidance not a hard limit. */
  targetLength: [min: number, max: number];
  /** How this platform's readers expect to be spoken to. */
  voice: string;
  /** Structural conventions. */
  structure: string;
  /** Tagging / hashtag habits. */
  tagging?: string;
}

export const PLATFORM_SHAPES: Record<string, PlatformShape> = {
  xiaohongshu: {
    targetLength: [200, 800],
    voice: '第一人称、口语、有具体场景和数字；像跟朋友分享踩坑经历，不像产品说明',
    structure: '开头一句抓人（痛点或反常识），中间分点讲，结尾一句行动建议或提问',
    tagging: '结尾 3-6 个话题标签，用平台里真实在用的词',
  },
  'xiaohongshu-video': {
    targetLength: [100, 400],
    voice: '比图文更短更直接，第一句就是钩子',
    structure: '一段话说清是什么、为什么值得看',
    tagging: '3-5 个话题标签',
  },
  'wechat-mp': {
    targetLength: [1200, 4000],
    voice: '完整、有条理、可以长；读者是坐下来读完的，不是刷到的',
    structure: '有小标题分节，开头交代背景，中间展开，结尾有结论或行动项',
  },
  'wechat-channels': {
    targetLength: [50, 300],
    voice: '极简，一两句说清',
    structure: '视频是主体，文字只是补充说明',
  },
  twitter: {
    targetLength: [100, 260],
    voice: '密度高、有观点、不客套；一句话一个信息点',
    structure: '不要开场白，直接进入内容；结论前置',
    tagging: '最多 1-2 个 hashtag，多了像营销号',
  },
  bilibili: {
    targetLength: [100, 500],
    voice: '偏社区口吻，可以带点玩梗，但信息要实',
    structure: '短段落，先说结论再补细节',
  },
  telegram: {
    targetLength: [50, 400],
    voice: '简短、直给；群成员是来拿信息的不是来读文章的',
    structure: '一条消息说一件事；有链接就放链接',
  },
  reddit: {
    targetLength: [200, 800],
    voice: '克制、具体、不推销；讲自己的实际经验和数据，让读者自己判断',
    structure: '直接回答问题；涉及自己的产品必须主动说明身份',
    tagging: '不要 hashtag，Reddit 没有这个习惯',
  },
  'blog-tech': {
    targetLength: [2000, 8000],
    voice: '技术深度优先；给出可复现的细节、命令、配置、数字',
    structure: '有明确的问题—方案—验证结构；代码块和表格该用就用',
  },
  'blog-life': {
    targetLength: [800, 3000],
    voice: '第一人称叙述，可以有情绪和主观判断；不需要技术严谨',
    structure: '按时间或主题线索展开，结尾有个人体会',
  },
};

/** Guidance block for one platform, or a neutral fallback. */
export function shapeGuidance(platform: string): string {
  const shape = PLATFORM_SHAPES[platform];
  if (!shape) return `${platform}: 按该平台常见形态写。`;

  const parts = [
    `${platform}:`,
    `  长度约 ${shape.targetLength[0]}-${shape.targetLength[1]} 字`,
    `  语气: ${shape.voice}`,
    `  结构: ${shape.structure}`,
  ];
  if (shape.tagging) parts.push(`  标签: ${shape.tagging}`);
  return parts.join('\n');
}

/**
 * Character-trigram Jaccard similarity, 0 to 1.
 *
 * Trigrams over characters rather than word tokens because Chinese has no
 * spaces — a word-based measure would score two completely different Chinese
 * texts as identical (both "one token"). Punctuation and whitespace are
 * stripped so formatting differences do not disguise identical prose.
 */
export function similarity(a: string, b: string): number {
  const ga = trigrams(a);
  const gb = trigrams(b);
  if (ga.size === 0 && gb.size === 0) return 1;
  if (ga.size === 0 || gb.size === 0) return 0;

  let shared = 0;
  for (const g of ga) if (gb.has(g)) shared += 1;
  return shared / (ga.size + gb.size - shared);
}

function trigrams(text: string): Set<string> {
  const normalized = text
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
  const out = new Set<string>();
  for (let i = 0; i + 3 <= normalized.length; i += 1) {
    out.add(normalized.slice(i, i + 3));
  }
  // Very short strings have no trigrams; fall back to the string itself.
  if (out.size === 0 && normalized) out.add(normalized);
  return out;
}

export interface DuplicateFinding {
  a: string;
  b: string;
  similarity: number;
}

/**
 * Find variant pairs that are too alike.
 *
 * The default threshold is deliberately generous — genuinely distinct posts
 * about the same subject share vocabulary, so this is meant to catch copies,
 * not to police overlap.
 */
export function findDuplicates(
  variants: Array<{ platform: string; body: string }>,
  threshold = 0.75,
): DuplicateFinding[] {
  const out: DuplicateFinding[] = [];
  for (let i = 0; i < variants.length; i += 1) {
    for (let j = i + 1; j < variants.length; j += 1) {
      const score = similarity(variants[i]!.body, variants[j]!.body);
      if (score >= threshold) {
        out.push({ a: variants[i]!.platform, b: variants[j]!.platform, similarity: score });
      }
    }
  }
  return out;
}
