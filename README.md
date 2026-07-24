# MediaBot

**跑在 Claude Code 上的媒体运营 Agent —— 给没有新媒体运营岗位的个人、社区和小公司。**

开源（Apache-2.0）、免费、自托管。数据全部留在本机。模型走你已经付费的 Claude Code 登录态，也可切到 Kimi / GLM / DeepSeek。

---

## 它做什么

媒体运营本质是五个环节的闭环，MediaBot 把它们串起来：

| 环节 | MediaBot 做的事 |
|---|---|
| **① 目标** | 实测基线 → 商定目标 → 周期复盘，并给自己的预测打分 |
| **② 内容** | 从素材生成多平台文案，本地 FLUX 出配图 |
| **③ 发布** | 小红书 / X / 公众号 / B站，一次生成多平台分发 |
| **④ 反馈** | 轮询自己帖子的评论，起草回复 |
| **⑤ 监控** | 关键词追踪 + 每日情报简报 |

**所有对外动作都要人点头。** 发布和回复都进同一个审批队列——它们是公开的、挂你名字的、发出去撤不回来。监控层只读，永远不会因为看到热点就自动发帖。

## 一天是这样的

```
07:30  简报到手：昨天监控到什么、哪些值得写
08:00  自动抓取素材 → 生成多平台草稿 + 配图 → 进审批队列
12:30  打开 localhost:7788，看草稿、改两句、点「批准」或「定时 18:00」
18:00  daemon 到点发布
每 30 分钟  拉新评论 → 起草回复 → 进审批队列；已批准的发出去
```

人每天花 15-30 分钟，全在**审阅**上。

---

## 快速开始

### 前置

- Node.js 20+、pnpm
- Claude Code 已登录（`claude --version` 能跑）
- 想发哪个平台，就装哪个平台的 CLI 并登录（见下表）

```bash
git clone https://github.com/iDoris-ai/MediaBot.git
cd MediaBot && pnpm install
```

### 配置

创建 `~/.mediabot/config.json`：

```json
{
  "targetPlatforms": ["xiaohongshu", "twitter"],
  "locale": "zh-CN",
  "style": "务实、有具体数字、不打鸡血",

  "feeds": ["https://example.com/feed.xml"],
  "searchPlatforms": ["xiaohongshu", "twitter"],
  "keywords": ["AI Agent", "开源工具"],

  "generateImages": true,

  "schedule": {
    "ingest":   "0 8 * * *",
    "publish":  "*/5 * * * *",
    "monitor":  "15 * * * *",
    "briefing": "30 7 * * *",
    "engage":   "*/30 * * * *",
    "goals":    "0 9 * * 1"
  }
}
```

### 跑起来

```bash
pnpm daemon      # 常驻进程 + 审批控制台 http://127.0.0.1:7788
```

或者用命令行：

```bash
pnpm cli providers          # 各 provider 健康状况
pnpm cli run                # 抓取 → 生成 → 进审批队列
pnpm cli queue              # 看待审内容
pnpm cli approve <id>       # 批准并发布
pnpm cli metrics            # 当前可采集的指标
pnpm cli goals              # 目标进度
```

---

## 平台支持

| 平台 | 发布 | 评论回复 | 走什么 | 需要装 |
|---|---|---|---|---|
| 小红书 | 图文 | ✅ | `xhs` CLI | [xhs-cli](https://github.com/) + `xhs login` |
| X / Twitter | 文+图 | ✅ | `twitter` CLI | twitter-cli + 登录 |
| 微信公众号 | **草稿** | — | 官方 API | `WECHAT_APP_ID` / `WECHAT_APP_SECRET` |
| B站 | 纯文本动态 | — | `bili` CLI | bili-cli + `bili login` |
| dry-run | 写本地文件 | — | 内置 | 无 |

**公众号只建草稿，不群发。** 公众号每天群发次数极少且不可撤回，最后一步由你在后台点发送。

**没配置的平台自动落到 dry-run**，内容写到 `~/.mediabot/out/`，你能看到「本来会发出去什么」。

## 监控源

| 来源 | 配置方式 |
|---|---|
| RSS / Atom | `feeds: ["https://..."]` |
| 小红书 / X / B站 关键词 | `searchPlatforms` + `keywords` |
| 任意 MCP server（Google Trends、竞品情报…） | `mcpSources` 加一项，**不用写代码** |

```json
"mcpSources": [
  { "id": "google-trends", "command": "npx", "args": ["-y", "google-trends-mcp"],
    "tool": "<用 healthCheck 查实际工具名>", "kind": "trend" }
]
```

## 换模型

```bash
export ANTHROPIC_BASE_URL=https://your-proxy   # Kimi / GLM / DeepSeek
export CLAUDE_MODEL=your-model
pnpm daemon
```

---

## 架构

MediaBot **是编排层 + 能力契约，不是能力实现本身**。四个可插拔槽位：

```
SourceProvider     只读输入   趋势 / 新闻 / 竞品
ComposerProvider   加工      文案 / 配图 / 配音
PublisherProvider  输出      各平台发布        ← 需审批
EngagementProvider 回环      评论回复          ← 需审批
```

外部能力按「最省事」接入：**MCP server 零代码**、**有 CLI 的包一层子进程**、**都没有才自研**。子进程调用不构成衍生作品，所以这条路对上游 license 也最干净。

想加一个平台？实现一个 provider，跑一遍一致性测试即可：

```bash
pnpm test:conformance --provider ./my-provider.ts --slot publisher
```

一致性套件是行为级的——会验证你声明的 `limits` 和实际行为一致、id 稳定可幂等、以及监控类 provider 没有偷偷暴露写方法。

详见 [`docs/architecture.md`](docs/architecture.md)、[`docs/spec.md`](docs/spec.md)、[`docs/research.md`](docs/research.md)（21 个开源方案的调研与 license 审计）。

## 部署约束

- **首次登录各平台 CLI 需要图形界面**（扫码 / 密码），之后可无头运行。纯 VPS 装不上。
- **Web 控制台只监听 127.0.0.1**，且会拒绝非回环来源——数据库里是平台凭证和待发内容。
- **审批不可全局关闭**，可按平台放宽。

## License

Apache-2.0 —— 见 [LICENSE](LICENSE)。
