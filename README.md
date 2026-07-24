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
pnpm drill                  # 端到端验收演练（dry-run，安全重跑）
pnpm cli providers          # 各 provider 健康状况
pnpm cli run                # 抓取 → 生成 → 进审批队列
pnpm cli queue              # 看待审内容
pnpm cli approve <id>       # 批准并发布
pnpm cli metrics            # 当前可采集的指标
pnpm cli goals              # 目标进度
pnpm cli rules              # 常驻授权，以及哪些目标可以授权
```

### 在手机上审批

配好 owner 之后，待审的草稿会**一条一条**推到 Telegram，直接回复「批准」或「拒绝」就生效，不用打开控制台：

```json
"notify": {
  "telegramBotToken": "secret:telegram-token",
  "telegramChatId": "12345",
  "telegramOwnerId": "12345"
}
```

`telegramOwnerId` 是你的**数字 user id**（问 @userinfobot）。**没配就整个功能关闭**——推送通常落在群里，认名字不认 id 意味着群里任何人都能以你的名义发东西。回复只能批准/拒绝，**改文案仍然要去控制台**：远程改文相当于把没人重读过的内容重新签名。

### 让它别再问同一件事

```bash
pnpm cli rules                                    # 看哪些能授权
pnpm cli allow publish:blog-tech /path/to/blog#src/content/blog
pnpm cli revoke "publish:blog-tech /path/to/blog#src/content/blog"
```

授权**绑定到确切目标**，不是绑定到平台名——配置改指向别的仓库，规则自动失效。

**不可撤回的平台永远不能授权**（小红书 / X / B站 / Telegram / 抖音…），即使手动往数据库里塞一条规则也会被拒。可授权的只有三类：写本地文件（dry-run）、git 可回滚（blog）、只建草稿（公众号）。

---

## 平台支持

| 平台 | 发布 | 评论回复 | 走什么 | 需要装 |
|---|---|---|---|---|
| 小红书 | 图文 | ✅ | `xhs` CLI | xhs-cli + `xhs login` |
| 小红书 | **视频** | ✅ | Playwright | selector 已填，**待实测确认** |
| X / Twitter | 文+图 | ✅ | `twitter` CLI | twitter-cli + 登录 |
| 微信公众号 | **草稿** | — | 官方 API | `WECHAT_APP_ID` / `WECHAT_APP_SECRET` |
| 微信视频号 | 视频 | — | Playwright | selector 已填，**待实测确认** |
| Telegram | 群定时发 | ✅ 条件触发 | Bot API | bot token + chat id |
| Reddit | 评论 | ✅ | `rdt` CLI | rdt-cli + `rdt login` |
| 技术 blog / 生活 blog | markdown | — | 写文件 + git | 本地仓库路径 |
| B站 | 纯文本动态 | — | `bili` CLI | bili-cli + `bili login` |
| 抖音 / 快手 | 视频 | — | Playwright | selector 待填 |
| dry-run | 写本地文件 | — | 内置 | 无 |

**公众号只建草稿，不群发。** 公众号每天群发次数极少且不可撤回，最后一步由你在后台点发送。

### 抖音 / 视频号 / 快手需要先填 selector

这三个平台没有 API 也没有 CLI，只能驱动网页。创作者后台的 DOM 经常变，所以 selector 是**配置**不是代码：

```bash
pnpm cli profiles      # 看每个平台还缺哪些 selector
```

打开对应的上传页，用开发者工具找到各个控件，填进 `config.browserProfiles.<平台>`，确认能跑通后把 `"verified": true` 打开。**没验证过的 profile 会拒绝发布**——乱猜的 selector 不会干净失败，它会点错按钮或留下半填的草稿。

### Telegram 群机器人

```json
"telegram": {
  "token": "secret:telegram-token",
  "chatId": "-1001234567890",
  "keywords": ["价格", "怎么装"]
}
```

**群里不会逢消息必回**——只在被 @、回复了 bot、命令、或命中关键词时才起草回复。逢消息必回的机器人一天就会被踢出群。

### Reddit

```json
"reddit": { "subreddits": ["selfhosted", "LocalLLaMA"] }
```

**一个公开属于你的账号**，不做多人设、不做自动点赞——那些是 vote manipulation，会让关联账号一起被封。日限默认 5 条，是其他平台的一半。

### Blog

```json
"blogs": {
  "blog-tech": { "repo": "/path/to/blog", "contentDir": "src/content/blog", "schema": "blog",
                 "urlPattern": "https://blog.example/blog/{slug}/" },
  "blog-life": { "repo": "/path/to/blog", "contentDir": "src/content/my", "schema": "my" }
}
```

**blog 是唯一审批后全自动完成的通道**——git 可撤回，误发一篇是 `git revert`，误发一条小红书是永久的。

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

## 密钥不要写进 config

Telegram token、webhook 认证头这类东西别明文放 `config.json`——那个文件会进备份、同步网盘、被贴进 issue。存到系统 keychain：

```bash
echo "BOT:your-token" | pnpm cli secret set telegram-token
# 输出：put this in config.json instead of the secret: "secret:telegram-token"
```

然后 config 里写引用：

```json
"notify": { "telegramBotToken": "secret:telegram-token", "telegramChatId": "12345" }
```

macOS 走 Keychain，其他系统回退到 AES-256-GCM 加密文件（0600）。

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
