# MediaBot 架构

> 前置阅读：[`research.md`](research.md)（21 个参考仓库的调研与 license 审计）

## 一、核心判断

MediaBot **是编排层 + 能力契约，不是能力实现本身**。

媒体运营涉及的开源能力有 30+ 个仓库（发布、视频生成、配音、趋势监控、情报聚合……）。如果把它们 fork/vendor 进来，项目会死于上游同步的维护负担。所以：

- **定义四个能力槽位（provider 契约）**，外部仓库作为可插拔实现接入
- MediaBot 自己只写：契约定义、daemon（调度/轮询/审批）、数据模型、Web UI；平台能力尽量走 ①/② 接入，只有确实无路可走时才 ③ 自研
- "兼容所有媒体"不靠我们写 40 个适配器，靠契约让社区各自补

## 二、三种接入方式

每个外部能力按"最省事"原则归类，决定了我们要写多少代码：

| 方式 | 适用 | 我们写的代码 | 典型 |
|---|---|---|---|
| **① MCP server** | 本身就是 MCP | **零**，仅配置 | google-trends-mcp、unifapi-agent、Dataslayer-AI |
| **② CLI 子进程** | 有命令行入口 | 薄 adapter（~50 行） | **xhs（小红书发布+互动）**、agent-reach、yt-dlp、ffmpeg、Pixelle-Video、OpenStoryline、marketing-studio |
| **③ 原生实现** | 无可用方案 / license 不可用 | 完整实现 | 尚无官方 API 且无可用 CLI 的平台（逐个评估） |

## 三、四个能力槽位

```
SourceProvider     输入   趋势 / 新闻 / 竞品 / 评论        只读
ComposerProvider   加工   图文 / 视频 / 配音 / 封面
PublisherProvider  输出   各平台发布                      需审批
EngagementProvider 回环   评论 / 私信回复                  需审批
```

### 3.1 SourceProvider（只读输入）

```typescript
interface SourceProvider {
  id: string;                              // "google-trends" | "agent-reach"
  kind: 'trend' | 'news' | 'competitor' | 'comment';
  fetch(query: SourceQuery): Promise<SourceItem[]>;
}

interface SourceQuery {
  keywords?: string[];
  since?: Date;
  limit?: number;
  locale?: string;                         // 'zh-CN' | 'en-US'
}

interface SourceItem {
  id: string;                              // provider 内唯一，用于跨轮次去重
  title: string;
  url?: string;
  summary?: string;
  score?: number;                          // 热度 / 相关度
  publishedAt?: Date;
  media?: MediaRef[];
  raw?: unknown;                           // 保留原始响应，便于后续重解析
}
```

**约束：SourceProvider 永远不写外部平台**（"eyes, not hands"）。监控信号只能进审批队列或情报简报，不能直接触发发布。

### 3.2 ComposerProvider（内容生产）

```typescript
type ContentKind = 'text' | 'image' | 'video' | 'audio';

interface ComposerProvider {
  id: string;
  produces: ContentKind[];
  compose(brief: ContentBrief): Promise<Draft>;
}

interface ContentBrief {
  goal?: string;                           // 来自 ① 目标层
  sources: SourceItem[];                   // 素材
  targetPlatforms: string[];               // 决定长度 / 版式 / 话题格式
  locale: string;
  style?: string;
}

interface Draft {
  id: string;
  variants: DraftVariant[];                // 一条内容，每平台一个变体
}

interface DraftVariant {
  platform: string;
  title?: string;
  body: string;
  media: MediaRef[];
  meta?: Record<string, unknown>;          // 平台专属：话题 / 标签 / 合集 / 定位
}
```

一条内容对多平台产出**不同变体**而非同一份复制——小红书的语气和 LinkedIn 完全不同，这是 `variants` 存在的理由。

### 3.3 PublisherProvider（发布）

```typescript
interface PublisherProvider {
  id: string;
  platform: string;
  transport: 'api' | 'cli' | 'browser' | 'extension';
  limits: PlatformLimits;

  checkAuth(): Promise<AuthState>;
  validate(v: DraftVariant): Promise<ValidationResult>;
  publish(v: DraftVariant, opts: PublishOptions): Promise<PublishResult>;
}

interface PlatformLimits {
  maxTextLength: number;
  maxImages?: number;
  video?: { maxSeconds: number; maxBytes: number; formats: string[] };
  supportsScheduling: boolean;             // 平台原生定时；false 则由 daemon 定时触发
}

interface PublishResult {
  platformPostId: string;
  url?: string;
  publishedAt: Date;
}
```

`transport` 字段区分四条技术路线，决定运行时需要什么（子进程？浏览器？插件？纯 HTTP？）。

> **重要法务性质**：`cli` 这条路是**通过子进程调用外部程序**，不构成衍生作品，因此即使上游 license 缺失或不兼容 Apache-2.0，也可以合法接入。这让"license 不明的上游"从不可用变成可用——是覆盖中文平台最省力且最干净的路径。

### 3.4 EngagementProvider（反馈回环）

```typescript
interface EngagementProvider {
  id: string;
  platform: string;
  listComments(postRef: PostRef, since?: Date): Promise<Comment[]>;
  reply(commentId: string, text: string): Promise<void>;
}
```

复用 PublisherProvider 的登录态，不单独维护凭证。

## 四、审批闸门

**所有对外动作必须过审批队列。这是架构的核心，不是一个功能。**

```
Composer 产出 Draft ─┐
Engagement 起草回复 ─┼─→ 审批队列 ─→ 人确认 ─→ 执行器
Source 只读产出     ─┘（不入此路，只进情报简报）
```

好处是后续无论加多少能力，失控风险都收敛在一个点上。

## 五、平台矩阵

"兼容所有媒体"靠四条腿：

| 路线 | 平台 | 说明 |
|---|---|---|
| **官方 API** | LinkedIn、YouTube、Mastodon、Telegram、Discord、Threads、TikTok、FB/IG | Postiz 已证明可行（借鉴接口形状，AGPL 代码不可抄） |
| **浏览器插件复用 session** | 10+ 平台，零 API Key | MultiPost-Extension（Apache-2.0）。⚠️ 其 RESTful API 经 `multipost.app` 第三方服务器中转，**与「数据不出本机」冲突，未采用**；本地可行路径见 tasks.md T5.5 |
| **CLI 子进程** | **小红书 + Twitter/X（发布 + 评论回复，均已实现）** | 通过 `xhs` / `twitter` CLI 复用既有登录态，**无需 X API 订阅**；风险是走逆向 API，平台变更可能失效——provider 契约正是用来隔离这个风险的 |
| **CLI 子进程（部分）** | B站动态（`bili dynamic-post`，纯文本） | 仅动态，视频投稿仍需另找方案 |
| **Playwright + Cookie** | 抖音、视频号、快手、B站、知乎、百家号 | 仍需自研（逐个确认是否已有可用 CLI） |

⚠️ **公众号特例**：有官方草稿箱/素材 API（social-auto-upload 未覆盖），但要求认证服务号 + IP 白名单，个人订阅号受限。**两条路都要备**——认证号走 API，其余走浏览器。

## 六、外部能力清单（按槽位）

### SourceProvider
| 能力 | 来源 | 接入方式 |
|---|---|---|
| Google Trends | `purahmanian/google-trends-mcp` | ① MCP |
| 社交监听 / 竞品情报 / SEO / GEO | `unifapi-agent/agents` | ① MCP |
| 广告 & 分析平台（50+） | `Dataslayer-AI/Marketing-skills` | ① MCP |
| 13 平台内容抓取 | `agent-reach` | ② CLI |
| 每日技术情报 | `jjyaoao/repo-courier` | ② CLI |
| 情报看板 | `weishao831/ai-intel-workbench` | ② CLI |
| Reddit 关键词监听 | `kai-cmo-harness/scripts/reddit_monitor` | ② CLI（MIT） |

### ComposerProvider
| 能力 | 来源 | 接入方式 |
|---|---|---|
| 短视频引擎（ComfyUI 底座） | `AIDC-AI/Pixelle-Video` | ② CLI |
| 视频剪辑 agent（Claude Code 原生） | `FireRedTeam/FireRed-OpenStoryline` | ② CLI |
| 浏览器录制转视频 | `browser-use/video-use` | ② CLI |
| 剪辑 agent | `ChatCut-Inc/agent-plugin`、`calesthio/OpenMontage` | ② CLI |
| 剪辑器底座 | `OpenCut-app/OpenCut`、`AIEraDev/clypra` | ② CLI |
| 发布物料全流水线 | `ucsandman/marketing-studio` | ⚠️ 未采用——是交互式 Claude Code 技能集，非可编程 CLI，见 tasks.md T5.4 |
| TTS / 配音 | MOSS-TTS、LuxTTS、KittenTTS 等 | ② CLI |
| 配图 | 本地 flux-gen（FLUX.2 Klein 4B MLX） | ② CLI |
| 文案 | Claude Code 本身 | 内置 |

### PublisherProvider
| 能力 | 来源 | 接入方式 |
|---|---|---|
| **小红书（发布 + 互动）** | `xhs` CLI | **② CLI（已实现）** |
| **Twitter/X（发布 + 互动）** | `twitter` CLI | **② CLI（已实现）** |
| B站动态（纯文本） | `bili` CLI | ② CLI（待接） |
| 抖音 / 视频号 / 快手 / B站视频投稿 | 优先找 CLI，否则 Playwright | ②，回退 ③ |
| 10+ 平台零配置 | `MultiPost-Extension` | ⚠️ 未采用，见 tasks.md T5.5 |
| 西方平台官方 API | 接口形状参考 Postiz `SocialProvider` | ③ 自研（不抄代码） |
| 公众号 | 官方草稿箱 API + 浏览器兜底 | ③ 自研 |

### EngagementProvider
| 能力 | 来源 | 接入方式 |
|---|---|---|
| **小红书评论 / 回复** | `xhs` CLI | **② CLI（已实现）** |
| **Twitter/X 回复** | `twitter` CLI | **② CLI（已实现）** |
| 回复起草策略 | 架构参考 `Smb-Marketing-Agent` 的 Echo Agent（无 LICENSE，仅看思路） | ③ 自研 |

## 七、运行形态

```
┌─────────────────────────────────────────────────┐
│  MediaBot daemon（常驻）                          │
│  · 调度器（定时发布 / 定时抓取）                    │
│  · 轮询器（评论 / 监控源）                          │
│  · 审批队列（所有对外动作的闸门）                    │
│  · SQLite（目标 / 草稿 / 发布记录 / 凭证）           │
└──────────────────┬──────────────────────────────┘
                   │ 每个需要"想"的任务 spawn 一次
                   ▼
        claude --print（大脑，模型可换 Kimi/GLM/DeepSeek）
                   │
                   ▼
        Provider 执行层（四个槽位的具体实现）

入口（可选，装哪个用哪个）：
  ① 本地 Web UI（localhost）  日历 / 审批 / 预览 / 情报 feed   ← 主入口
  ② CLI（mediabot …）         极客 + debug + 脚本化
  ③ Claude Code 插件           /mediabot:… 在已开会话里直接调
  ④ IM 推送（微信/Telegram）   手机审批，可对接 Heinu1
```

**数据全部留在本机**，Web UI 是 localhost 而非 SaaS——cookie 和 token 不出本机是硬要求。

## 八、部署约束（必须写进 README）

1. **Playwright 路线需要真实浏览器 + 登录态**：首次登录必须在有 GUI 的机器上完成（扫码/密码），之后可 headless 运行。**纯无头 VPS 无法完成首次登录**。
2. **模型后端**：默认复用 Claude Code 订阅登录态（不需额外 API Key）；可通过 `ANTHROPIC_BASE_URL` 切到 Kimi / GLM / DeepSeek。
3. **审批默认开启**：发布与回复默认需人确认，可按平台/按 provider 配置放宽，但不提供"全局关闭审批"开关。
