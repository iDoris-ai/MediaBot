# MediaBot

**跑在 Claude Code 上的媒体运营助手 —— 给没有专职新媒体岗位的个人、社区和小团队。**

开源（Apache-2.0）、免费、自托管。cookie 和待发内容全部留在你自己的电脑上。模型走你**已经付费的 Claude Code 登录态**，也可以切到 Kimi / GLM / DeepSeek。

---

## 一、它解决什么问题

一个人运营好几个平台，真正耗时的从来不是「点发送」，是这些：

- 每天要盯行业动态、找选题
- 同一件事要改写成小红书、公众号、X、B站四种不同的样子
- 帖子发出去还得回评论、维系互动
- 想主动到相关话题下露个脸引流，又怕水、怕被封

MediaBot 把这些**自动做到「差一步」**，把最后那一步——**要不要发、发成什么样**——留给你。你每天花 15–30 分钟，全花在**审阅**上，不在操作上。

### 核心原则:所有对外动作都要你点头

发帖、回复，全部进**同一个审批队列**，你批了才发。因为这些是公开的、挂你名字的、发出去撤不回来的。

监控层是**只读的**——它只会给你「看到了什么、值得写什么」，永远不会因为刷到个热点就自动替你发帖。

---

## 二、它能做什么

媒体运营本质是五个环节的闭环，MediaBot 把它们串起来：

| 环节 | MediaBot 做的事 |
|---|---|
| **① 目标** | 实测基线 → 和你商定可验证的目标 → 周期复盘，还会给自己的预测打分 |
| **② 内容** | 从素材生成**各平台不同形态**的文案，可本地出配图 / 配音 / 成片 |
| **③ 发布** | 小红书 / 公众号 / 视频号 / X / B站…一次生成，多平台分发 |
| **④ 反馈** | 轮询自己帖子下的评论，起草回复给你过目 |
| **⑤ 监控** | 关键词 + RSS 追踪，每天一份情报简报 |

### 支持的平台

| 平台 | 发布 | 评论回复 | 走什么 | 需要装 |
|---|---|:---:|---|---|
| 小红书 | 图文 | ✅ | `xhs` CLI | xhs-cli + 登录 |
| 小红书 | 视频 | ✅ | Playwright | selector 已填，**待你实测确认** |
| X / Twitter | 文+图 | ✅ | `twitter` CLI | twitter-cli + 登录 |
| 微信公众号 | **草稿** | — | 官方 API | AppID / AppSecret |
| 微信视频号 | 视频 | — | Playwright | selector 已填，**待你实测确认** |
| Telegram | 群定时发 | ✅ 条件触发 | Bot API | bot token + chat id |
| Reddit | 评论 | ✅ | `rdt` CLI | rdt-cli + 登录 |
| 技术 / 生活 blog | markdown | — | 写文件 + git | 本地仓库路径 |
| B站 | 纯文本动态 | — | `bili` CLI | bili-cli + 登录 |
| 抖音 / 快手 | 视频 | — | Playwright | **selector 待填** |
| dry-run（演练） | 写本地文件 | — | 内置 | 无 |

> **没配置的平台自动落到 dry-run**——内容写到 `~/.mediabot/out/`，你能看到「本来会发出去什么」，但什么都不会真的发出去。这也是你第一次上手最该用的模式。

---

## 三、安装

### 前置

- **Node.js 20 以上**、**pnpm**
- **Claude Code 已登录**（终端里 `claude --version` 能跑）——这是「大脑」，模型走它，不需要额外 API Key
- 想发哪个平台，才需要装那个平台的 CLI 并登录（见上表，可以以后再说）

### 装起来

```bash
git clone https://github.com/iDoris-ai/MediaBot.git
cd MediaBot
pnpm install
```

### 生成配置

```bash
pnpm cli init
```

这会在 `~/.mediabot/config.json` 写一份**开箱即用**的起步配置：只发到 dry-run（不碰任何真实平台），带一个公开 RSS 源当素材。

> 所有命令都用 `pnpm cli <命令>`（在项目目录里跑）。想在任何地方直接敲 `mediabot`，可以 `pnpm link --global`，非必须。

---

## 四、第一次跑通(不需要任何账号)

先在最安全的模式下把整条链路走一遍，确认装对了：

```bash
pnpm cli run --dry --auto
```

你会看到类似：

```
ingested 20 new of 20 fetched      ← 抓到 20 条素材
queued 1 for approval              ← 生成了 1 条草稿
published 1                        ← "发布"到本地（dry-run）
```

看产出：

```bash
pnpm cli status                    # 各表计数 + 最近运行
ls ~/.mediabot/out/dryrun/         # 生成的内容就在这里
```

打开 `~/.mediabot/out/dryrun/` 里的 `.md` 文件，就是它「本来会发出去的东西」。

**到这一步，说明抓取 → 生成 → 发布这条链路是通的。** 接下来才是接真实平台。

---

## 五、接第一个真实平台(建议从 blog 开始)

blog 是**唯一审批后全自动、且可撤回**的通道——误发一篇 `git revert` 就好，误发一条小红书是永久的。所以拿它先熟悉流程最稳。

### 1) 配置

编辑 `~/.mediabot/config.json`，加上你的 blog 仓库：

```json
{
  "targetPlatforms": ["blog-tech"],
  "blogs": {
    "blog-tech": {
      "repo": "/path/to/your/blog",
      "contentDir": "src/content/blog",
      "schema": "blog",
      "urlPattern": "https://yourblog.com/blog/{slug}/"
    }
  }
}
```

### 2) 生成草稿

```bash
pnpm cli run          # 抓取 → 生成 → 进审批队列（这次不加 --auto，停在审批前）
pnpm cli queue        # 看有什么待审
```

### 3) 审批并发布

```bash
pnpm cli approve <上面列出的 id>
```

批准后它会写文件、commit（默认也 push）。去你的 blog 仓库看，文章已经在了。

> **想「以后这个 blog 别再问我」？** 见 [第八节·省心授权](#八让它别再问同一件事)。这个能力**只对可撤回的通道开放**。

---

## 六、日常怎么用:开着 daemon,在手机上审批

熟悉之后，真正的用法是把 daemon 挂起来，它自己按点抓取、生成、到点发布：

```bash
pnpm daemon
```

启动后：

- 常驻进程按 `schedule` 里的 cron 定时干活
- 审批控制台在 **http://127.0.0.1:7788**（只监听本机，别人访问不了）

### 一天大概是这样

```
07:30  情报简报到手：昨天监控到什么、哪些值得写
08:00  自动抓素材 → 生成多平台草稿 → 进审批队列，推送提醒你
12:30  打开 localhost:7788，看草稿、改两句、点「批准」或「定时 18:00」
18:00  daemon 到点发布
每 30 分钟  拉新评论 → 起草回复 → 进队列；已批准的发出去
```

### 在手机上直接批(可选,但很省事)

配好之后，待审的草稿会**一条一条**推到 Telegram，你直接回复「批准」或「拒绝」就生效，不用打开电脑：

```json
"notify": {
  "telegramBotToken": "secret:telegram-token",
  "telegramChatId": "你的 chat id",
  "telegramOwnerId": "你的数字 user id"
}
```

- `telegramOwnerId` 是你的**数字 user id**（给 [@userinfobot](https://t.me/userinfobot) 发条消息就能拿到）
- **没配 ownerId 就整个功能关闭**——推送通常落在群里，只认名字不认 id 意味着群里任何人都能替你发东西，这是不允许的
- 回复只能**批准 / 拒绝**；**改文案仍然要去控制台**——远程改文相当于把没人重读过的内容重新签名

---

## 七、几个关键场景的全流程

### 场景 A:同一条内容,发成小红书 + 公众号 + blog 三种样子

这是 MediaBot 最核心的价值——**不是复制粘贴，小红书像小红书、公众号像公众号**。

1. 配置里 `targetPlatforms` 列上三个平台：
   ```json
   "targetPlatforms": ["xiaohongshu", "wechat-mp", "blog-tech"]
   ```
2. `pnpm cli run` —— 它会为同一份素材生成**三个不同形态的变体**：小红书重钩子和标签、公众号重结构、blog 重深度
3. `pnpm cli queue` 逐条审阅，或去控制台一眼看完
4. 分别批准 —— 公众号只会**建草稿**（最后群发那一下留给你在后台点），blog `git` 直接落地，小红书走 CLI 发出

### 场景 B:Telegram 群里定时发 + 自动回复

```json
"telegram": {
  "token": "secret:telegram-token",
  "chatId": "-1001234567890",
  "keywords": ["价格", "怎么装"]
}
```

- 群里**不会逢消息必回**——只在被 @、有人回复了 bot、命令、或命中关键词时才起草回复（逢消息必回的 bot 一天就被踢）
- 起草的回复照样进审批队列

### 场景 C:主动到别人相关帖子下引流(默认关闭)

这是唯一会动到**陌生人内容**的能力，所以约束最严：

```json
"outreach": { "enabled": true, "dailyLimits": { "reddit": 5 }, "perRun": 3 }
```

- 每平台**硬性日限**（从数据库强制，不是内存里数数）+ 随机间隔
- 模型被要求「没有具体、有价值的话可说，就回 SKIP」——**宁可不发，一条水评论比不发更伤号**
- 每条评论仍要你批

### 场景 D:设一个可验证的目标,让它替你盯

```bash
pnpm cli goal new followers 5000 "三个月粉丝到 5000"
pnpm cli goal measure <id>    # 测当前基线
pnpm cli goal start <id>      # 激活
pnpm cli goal review <id>     # 周期性复盘，并给上次预测打分
```

---

## 八、让它别再问同一件事

对**可撤回**的通道，你可以授权它以后自动批准，不再逐条问：

```bash
pnpm cli rules                                    # 先看哪些能授权
pnpm cli allow publish:blog-tech /path/to/blog#src/content/blog
pnpm cli revoke "publish:blog-tech /path/to/blog#src/content/blog"
```

两条硬规矩：

- **授权绑定到确切目标**，不是平台名——你改配置指向别的仓库，规则自动失效
- **不可撤回的平台永远不能授权**（小红书 / X / B站 / Telegram / 抖音…），即使手动往数据库里塞一条规则也会被拒。可授权的只有三类：写本地文件（dry-run）、git 可回滚（blog）、只建草稿（公众号）

---

## 九、密钥不要写进 config

Telegram token、webhook 认证头这类东西别明文放 `config.json`——那个文件会进备份、同步网盘、被贴进 issue。存到系统 keychain：

```bash
echo "你的-token" | pnpm cli secret set telegram-token
# 输出：put this in config.json instead: "secret:telegram-token"
```

然后 config 里写引用 `"secret:telegram-token"` 即可。macOS 走 Keychain，其他系统回退到 AES-256-GCM 加密文件（0600）。

---

## 十、换模型

默认复用 Claude Code 登录态。想切别的后端：

```bash
export ANTHROPIC_BASE_URL=https://your-proxy   # Kimi / GLM / DeepSeek
export CLAUDE_MODEL=your-model
pnpm daemon
```

---

## 十一、安全边界(装之前你该知道的)

- **首次登录各平台 CLI 需要图形界面**（扫码 / 密码），之后可无头运行。**纯 VPS 装不上**。
- **Web 控制台只监听 127.0.0.1**，且会拒绝非回环来源——数据库里是平台凭证和待发内容，绝不出本机。
- **审批不可全局关闭**，只能对可撤回的通道按目标放宽。
- **抖音 / 视频号 / 快手 selector 是配置不是代码**——创作者后台 DOM 常变。**没验证过的 profile 会拒绝发布**（`pnpm cli profiles` 看还缺什么），乱猜的 selector 不会干净失败，它会点错按钮或留半个草稿。

---

## 十二、常用命令速查

```bash
pnpm cli init                    # 生成起步配置
pnpm cli run [--dry] [--auto]    # 抓取 → 生成 → 进审批队列（--auto 直接批+发）
pnpm cli queue [state]           # 看待审内容
pnpm cli approve <id> [--now]    # 批准并发布（--now 忽略排期立刻发）
pnpm cli reject <id> [reason]    # 拒绝
pnpm cli rules                   # 常驻授权，以及哪些目标可授权
pnpm cli allow <action> <target> # 对某个确切目标以后不再询问
pnpm cli revoke "<entry>"        # 撤销授权
pnpm cli status                  # 各表计数 + 最近运行
pnpm cli providers               # 各 provider 健康状况
pnpm cli profiles                # 浏览器发布 profile 还缺哪些 selector
pnpm cli metrics                 # 当前可采集的指标
pnpm cli goals                   # 目标进度
pnpm cli secret set <name>       # 存密钥（读 stdin），打印引用
pnpm daemon                      # 常驻进程 + 控制台 http://127.0.0.1:7788
```

---

## 架构与设计

想了解 MediaBot 怎么做到「兼容所有媒体」而不用自己写 40 个适配器、每个平台的接入取舍、以及审批闸门为什么是架构核心，见：

- [`docs/architecture.md`](docs/architecture.md) —— 四个能力槽位与契约
- [`docs/research.md`](docs/research.md) —— 22 个开源方案的调研与 license 审计
- [`docs/acceptance.md`](docs/acceptance.md) —— 「做成了没有」的验收标准

## License

Apache-2.0 —— 见 [LICENSE](LICENSE)。
