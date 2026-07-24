# MediaBot 任务拆分

> 前置：[`spec.md`](spec.md)（数据结构与状态机）·[`architecture.md`](architecture.md)（契约与槽位）
>
> 每个任务自包含，可独立执行与验收。**验收标准必须可机器验证**（跑命令能判定通过与否），便于自动化循环推进。
> 状态标记：`[ ]` 未开始 · `[~]` 进行中 · `[x]` 完成

---

## M0 — 骨架与契约

### T0.1 项目脚手架 `[x]`
**依赖**：无
**交付物**：`package.json`（pnpm）、`tsconfig.json`（strict、CommonJS）、目录结构、`pnpm typecheck` / `pnpm test` 脚本
**验收**：`pnpm install && pnpm typecheck` 零错误

### T0.2 四个 provider 契约定义 `[x]`
**依赖**：T0.1
**交付物**：`src/contracts/{source,composer,publisher,engagement,common}.ts` + `index.ts`，严格按 architecture.md §3 的签名
**验收**：`pnpm typecheck` 通过；契约文件不含任何具体实现（纯 type/interface）

### T0.3 SQLite 数据层 `[x]`
**依赖**：T0.1
**交付物**：`src/core/db.ts` —— 按 spec.md §2 建全部 8 张表，WAL 模式，迁移机制（版本号 + 顺序迁移）
**验收**：单测——空目录初始化后 8 张表齐全、索引齐全、重复初始化幂等

### T0.4 幂等与哈希工具 `[x]`
**依赖**：T0.1
**交付物**：`src/core/identity.ts` —— `idempotencyKey()`、`payloadHash()`、退避计算 `backoffMs(attempt)`
**验收**：单测——相同输入产出相同键；不同输入不碰撞；退避序列为 1min/5min/25min

---

## M1 — 最小闭环（dry-run 打通）

### T1.1 Claude 执行器 `[x]`
**依赖**：T0.1
**交付物**：`src/core/claude.ts` —— spawn `claude --print --output-format stream-json --verbose`，解析 JSONL，支持 `ANTHROPIC_BASE_URL` 切后端，超时与中断
**验收**：集成测试——给定 prompt 能拿到文本结果与 `cost_usd`；`--model` 可覆盖
**参考**：Heinu1 `bot/src/claude/runner.ts` 是同一模式的可用实现

### T1.2 SourceProvider：RSS `[x]`
**依赖**：T0.2, T0.3
**交付物**：`src/providers/source/rss.ts` —— 实现 `SourceProvider`，抓 RSS/Atom
**验收**：契约测试通过；对固定 fixture 产出稳定 `SourceItem[]`；重复抓取不产生重复行

### T1.3 ComposerProvider：Claude `[x]`
**依赖**：T1.1, T0.2
**交付物**：`src/providers/composer/claude.ts` —— 按 `ContentBrief` 生成多平台 `variants`，结构化输出（JSON 块）+ 解析失败兜底
**验收**：契约测试通过；`targetPlatforms` 中每个平台都有对应 variant；解析失败时 draft 标 discarded 而非崩溃

### T1.4 PublisherProvider：dry-run `[x]`
**依赖**：T0.2
**交付物**：`src/providers/publisher/dryrun.ts` —— 不联网，把 variant 写入 `./out/<platform>/<id>.json/.md`，返回伪 `PublishResult`
**验收**：契约测试通过；产物文件内容与输入 variant 一致
**说明**：这是让整条链路在**无任何真实凭证**下可测的关键

### T1.5 审批闸门 `[x]`
**依赖**：T0.3, T0.4
**交付物**：`src/core/approval.ts` —— 入队（快照 + 哈希）、列表、批准、拒绝、执行前哈希校验
**验收**：单测——批准后篡改 payload 则执行被拒绝并重新入队；拒绝不产生 post

### T1.6 流水线编排 `[x]`
**依赖**：T1.2–T1.5
**交付物**：`src/core/pipeline.ts` —— `fetch → compose → validate → approval → publish` 全链路
**验收**：集成测试——RSS fixture 输入，走完全链路，dry-run 产物落盘，`posts.state=published`

### T1.7 CLI `[x]`
**依赖**：T1.6
**交付物**：`src/cli.ts` —— `mediabot run|queue|approve <id>|reject <id>|status|providers`
**验收**：`mediabot run --dry` 后 `mediabot queue` 能看到待审；`approve` 后产物落盘

### T1.8 Conformance Kit `[x]`
**依赖**：T0.2
**交付物**：`src/testing/conformance.ts` + `pnpm test:conformance --provider <path> --slot <slot>`
**验收**：对 T1.2/T1.3/T1.4 三个内置 provider 全部通过；故意破坏某个实现时能失败
**说明**：**"外部可接入"成立与否的关键**，见 spec.md §5

### T1.9 CI `[x]`
**依赖**：T1.8
**交付物**：`.github/workflows/ci.yml` —— typecheck + unit + conformance
**验收**：PR 上绿灯

---

## M2 — 真实发布：中文平台（唯一真空）

### T2.1 浏览器会话管理 `[x]`
**交付物**：`src/core/browser.ts` —— Playwright 上下文、登录态经 T2.2 凭证层加密持久化、探活、交互式首登
**验收**：✅ 13 测试通过；**真实 Chromium 验证 cookie 保存→新会话恢复**
**关键设计**：
- 登录态 = 账号完全控制权，所以走 keychain / 加密文件，不落明文 JSON（有测试遍历目录断言）
- 探活失败返回 `{ok:false}` 而非抛异常——单平台掉线不应中断整个 tick，调用方据此置 `needs_reauth`
- 存档损坏时丢弃重来，而不是每次 tick 都炸
- headless 下拒绝交互式登录（扫码/短信必须有可见窗口）
- Playwright 懒加载：不装浏览器也能跑全部测试和纯 CLI 流程
**依赖说明**：本机 chromium 已由其他项目缓存，只新增了 npm 包

### T2.2 凭证保管 `[x]`
**交付物**：`src/core/credentials.ts` —— macOS Keychain 优先，回退 AES-256-GCM 加密文件（0600）；config 里只放 `secret:<name>` 引用
**验收**：✅ 15 测试通过，含「密钥绝不以明文出现在磁盘任何文件里」「篡改密文被 GCM 认证标签拒绝」；真实 Keychain 读写删验证通过
**解决的真实问题**：`telegramBotToken` 和 webhook 认证头此前是明文躺在 `config.json` 里——那个文件会进备份、同步到网盘、被贴进 issue
**关键细节**：引用解析不到时返回 `undefined` 而非引用字符串本身，否则会把字面量 `"secret:xxx"` 当 token 发出去

### T2.3 小红书 Publisher `[x]`
**依赖**：无（改用 CLI 路线，不再依赖 T2.1/T2.2）
**交付物**：`src/providers/publisher/xiaohongshu.ts` + `src/providers/engagement/xiaohongshu.ts` + `src/core/cli-adapter.ts`
**验收**：✅ 17 测试通过（含发布与互动契约套件）；dry-run 绝不触达平台；真实二进制 checkAuth 打通
**实现修正**：原计划用 Playwright 自研，实际发现 `xhs` CLI 已提供 `post`/`comment`/`reply`/`comments` 全套能力，改走 **② CLI 子进程**。子进程调用不构成衍生作品，license 干净。

### T2.3b Twitter/X Publisher + Engagement `[x]`
**依赖**：无（CLI 路线）
**交付物**：`src/providers/publisher/twitter.ts` + `src/providers/engagement/twitter.ts`
**验收**：✅ 14 测试通过（含双槽位契约套件）；dry-run 不触达平台；真实二进制 checkAuth 打通
**说明**：计划外新增。原本 X 被归为"③ 自研官方 API"，实际 `twitter` CLI 已有 post/reply/tweet 全套，改走 ② CLI，**且无需 X API 订阅**。CJK 权重计数（中文字符算 2）避免 280 字上限误判。

### T2.4 公众号 Publisher `[x]`
**依赖**：无（官方 API 路线，不需要浏览器）
**交付物**：`src/providers/publisher/wechat-mp.ts`
**验收**：✅ 13 测试通过（含契约套件）；token 缓存与过期刷新；错误码分类（40001 可重试 / 61004 IP 白名单不可重试 / 45009 限流可重试）
**关键设计**：**只建草稿，绝不群发**。公众号每日群发次数极少且不可撤回，`freepublish/submit` 不调用——人在后台点发送。有测试断言从不请求 freepublish。
**实现来源**：API 路径复用 `jhfnetboy/wechat-content-pipeline`（**你自己的仓库，MIT**），TS 重写并接入契约。

### T2.5 B站动态 Publisher `[x]`
**交付物**：`src/providers/publisher/bilibili.ts`（`bili dynamic-post`，纯文本动态）
**验收**：✅ 9 测试通过；**不声明 video 支持**——CLI 没有投稿能力，谎报会在发布时才炸
**说明**：抖音 / 视频号 / 快手 / B站视频投稿仍无 CLI，需 Playwright，另开任务（见 T2.6）

### T2.6 抖音 / 视频号 / 快手（浏览器发布）`[x]` — 框架完成，selector 待实测
**交付物**：`src/providers/publisher/browser-publisher.ts` —— selector 驱动的通用上传发布器 + 三个平台的 profile 模板
**验收**：✅ 13 测试通过（含契约套件）；上传动作顺序、失败处理、dry-run 全覆盖
**核心设计决策**：
- **selector 放配置不放源码**——创作者后台 DOM 说变就变，硬编码等于每次改版都要发一个新版本；配置改两行即可
- **未验证的 profile 拒绝发布**，并给出「去哪个页面、改哪个配置、改完设 verified:true」的完整指引。乱猜的 selector 不会干净地失败，它会点错按钮或留下半填的草稿——大声拒绝严格优于盲目尝试
- **成功必须被观测到，不能从「点击没报错」推断**——发布按钮的点击经常被校验提示吞掉，那样会把没发出去的内容记成已发布
**未完成部分（诚实说明）**：三个模板的 selector 是**占位符不是实测值**。我没有这些创作者后台的访问权，凭记忆写的 selector 上线即错。需要有人登录后逐个核对再把 `verified` 打开。`mediabot profiles` 会列出每个 profile 还缺哪些 selector

---

## M3 — Web UI（主入口）

### T3.1 daemon `[x]`
**依赖**：T1.6
**交付物**：`src/daemon.ts` —— 调度器（cron）、轮询器、重试队列、优雅退出；launchd/systemd 单元文件
**验收**：定时任务到点触发；重启后不重复发布（幂等键生效）

### T3.2 本地 HTTP API `[x]`
**依赖**：T3.1
**交付物**：`src/server/api.ts` —— 仅监听 localhost，REST：草稿/审批/日历/情报/账号/运行日志
**验收**：非 localhost 请求被拒绝

### T3.3 Web UI `[x]`
**依赖**：T3.2
**交付物**：审批队列（图文预览）、发布日历、情报 feed、账号状态、运行日志
**验收**：能在浏览器完成"看草稿 → 改 → 批准 → 定时"全流程

### T3.4 通知适配器 `[x]`
**交付物**：`src/providers/notify/` —— 通用 Webhook（Slack/Discord/n8n/自建桥接皆可）+ Telegram Bot
**验收**：✅ 10 测试通过。**推送失败绝不影响流水线**——内容已经安全进队列，丢的只是提醒
**细节**：Telegram Bot API 失败时返回 HTTP 200 + `ok:false`，当成功会让配置错误永远静默，已单独覆盖；只配 token 不配 chatId 视为未配置而非半启用
**范围调整**：原计划「微信对接 Heinu1 + 手机端回复指令改审批状态」——Heinu1 是轮询型 bot，没有可供 MediaBot 调用的入站接口，需要 Heinu1 侧先开一个 endpoint。通用 Webhook 已经留好了对接口子，另开任务跟进

---

## M4 — 监控层

### T4.1 MCP 客户端接入层 `[x]`
**交付物**：`src/core/mcp.ts`（stdio JSON-RPC 客户端）+ `src/providers/source/mcp.ts`（包装成 SourceProvider）
**验收**：✅ 15 测试通过，**跑的是真实 MCP 协议握手**（fixture 是一个真的 stdio server，不是对自己假设的 mock）；配置即接入
**健壮性**：服务器中途死亡 → 拒绝而非挂起；请求超时有上限；缺二进制报 misconfigured 不重试；工具输出兼容 JSON 数组 / 包装对象 / 纯文本行

### T4.2 Google Trends `[x]`（配置即接入）
**交付物**：无需代码——在 `config.json` 的 `mcpSources` 加一项：
```json
{"id":"google-trends","command":"npx","args":["-y","google-trends-mcp"],"tool":"<工具名>","kind":"trend"}
```
**验收**：T4.1 的通用适配层已覆盖；工具名以 `healthCheck` 报出的实际列表为准

### T4.3 CLI 搜索型 Source `[x]`
**交付物**：`src/providers/source/cli-search.ts` —— 小红书 / Twitter / B站 关键词监控，共用一套映射框架
**验收**：✅ 14 测试通过（含 eyes-not-hands 契约）；真实小红书抓取验证通过
**说明**：agent-reach 本身是路由器/安装器，实际抓取由底层 CLI 完成，因此直接适配底层 CLI 更直接。单个关键词失败不影响其他关键词；登录过期则中止而非静默返回空。

### T4.4 情报简报 `[x]`
**交付物**：`src/core/briefing.ts` + daemon `briefing` 定时任务（默认 07:30）
**验收**：✅ 8 测试通过；**有测试断言简报不创建 drafts/approvals/posts 任何一行**——监控只做眼睛不做手
**降级设计**：模型不可用时输出原始信号列表，不因此丢掉整轮监控结果

### T4.5 竞品 / SEO / 社交监听 `[x]`（配置即接入）
**交付物**：同 T4.2，`mcpSources` 加一项指向 unifapi MCP server
**验收**：走同一条只读通路；`SourceProvider` 契约禁止写方法，conformance 套件强制

---

## M5 — 内容生产扩展

### T5.1 配图 `[x]`
**交付物**：`src/providers/composer/flux-image.ts` + `src/providers/composer/chain.ts`
**验收**：✅ 13 测试通过；真实 FLUX.2 Klein 出图验证（42s / 768×768 / 751KB）
**契约新增**：`ComposerProvider.composeAssets?()`（可选，附加式不破坏现有 provider）——图像/音频/视频天然产出的是文件而非「每平台一版」，由 ChainComposer 喂给文本 composer 的 `brief.assets`
**降级设计**：配图失败只降级为纯文字帖，不吞掉整条内容；chain 健康检查对资产 provider 失败报 degraded 而非 down

### T5.2 TTS / 配音 `[x]`
**交付物**：`src/providers/composer/tts.ts` —— 系统 TTS（macOS `say`）+ ffmpeg 转 AAC
**验收**：✅ 12 测试通过；真实合成中文口播（7 秒音频，2 秒出片，audio/mp4）
**为什么用 say 而不是 MOSS-TTS/LuxTTS**：本机有 CosyVoice 模型但没装推理 CLI，装一套环境才能用；`say` 零安装即可用，中文语音（Tingting zh_CN）质量够做短视频旁白。**这是下限不是上限**——更好的引擎按同一接口接进来即可
**降级设计**：ffmpeg 不可用时保留 AIFF 而非丢掉音频；拿不到时长不影响产出（时长只用于平台限制校验）；`say` 退出码 0 但没写文件视为失败

### T5.3 短视频生成 `[x]`
**交付物**：`src/providers/composer/video.ts` —— 配图 + 旁白 → 竖屏成片（ffmpeg）
**验收**：✅ 13 测试通过；**真实全链路验证**：FLUX 出图 41s → TTS 旁白 1.6s → ffmpeg 拼接 0.7s，产出 h264 1080×1920 + aac 音轨、4.2s、146KB，ffprobe 确认可播
**为什么没接 Pixelle-Video / OpenStoryline**：那两个要先装 ComfyUI 或搭模型服务。手上已有本地出图 + 本地 TTS + ffmpeg，直接拼出抖音/视频号真正收的格式，用户装完就能出第一条片。**这是务实的下限**，重型引擎按同一接口后续可接
**顺带修掉一个真 bug**：`ChainComposer` 原本给每个资产 provider 传的都是**原始 brief**，视频合成器因此永远看不到前面刚生成的图和音频，会静默返回空。改成资产逐级累积，并加了回归测试
**关键细节**：`-pix_fmt yuv420p` 不加的话很多播放器和平台直接拒收；concat 列表末尾重复最后一张图，否则 ffmpeg 会吃掉最后一个 duration 导致收尾镜头被截断

### T5.4 发布物料流水线 `[评估后不做]`
**结论**：marketing-studio 不是可编程调用的 CLI，而是 **Claude Code 交互式技能集**（`skills/` 下一堆 SKILL.md）+ Remotion 动画工作室；`launch.py` 只是启动 Remotion 开发服务器。
**为什么不接**：唯一的接法是 spawn 一个 claude 会话去触发 `/marketing` 技能，但那要求用户先把技能装进自己的 Claude Code，且输出是非结构化的对话文本——不符合 provider 契约要的确定性产物。
**已有替代**：封面已由 T5.1 本地 FLUX 覆盖；配音 T5.2；成片 T5.3。marketing-studio 的差异化价值是 Remotion 做的 Logo 动画和发布视频，那是另一套重型依赖（Node + Remotion + 交互式编辑），**用户想要时直接用它本身比经 MediaBot 转一道更好**。

### T5.5 MultiPost 插件通道 `[评估后不做——与核心承诺冲突]`
**结论**：MultiPost 的「RESTful API」**不是本地接口**。扩展轮询的是 `https://multipost.app`（`src/background/services/api.ts:6`，生产环境硬编码），链路是：
```
调用方 → multipost.app（第三方服务器） → 扩展轮询取任务 → 各平台
```
**为什么不接**：这会让待发内容经过第三方服务器，直接违背 MediaBot 写在 README 和 architecture.md 里的核心承诺「数据全部留在本机」——Web 控制台只绑 loopback 也正是为此。**为了多覆盖几个平台就把这条底线破掉，不划算。**
**真正可行的本地路径（留给后续）**：扩展支持从「受信任域名」的网页直接发消息（`MULTIPOST_EXTENSION_REQUEST_PUBLISH`，默认信任列表见 `src/background/index.ts:25`）。把 `127.0.0.1:7788` 加进信任域名后，MediaBot 控制台页面可以直接与扩展通信，全程不出本机。这需要装扩展才能验证，我没有环境实测，**因此没有写未经验证的浏览器胶水代码**。

---

## M6 — 反馈层

### T6.1 评论轮询 `[x]`
**交付物**：`src/core/engagement.ts` 的 `poll()` + daemon `engage` 定时任务（默认每 30 分钟）
**验收**：✅ 重复轮询不产生重复行（id 命名空间化）；单平台失败不影响其他平台

### T6.2 回复起草 + 审批 `[x]`
**交付物**：`draftReplies()` + `sendApproved()`，复用同一审批闸门（`kind='reply'`）
**验收**：✅ 13 测试通过。待审/被拒绝绝不发送；批准后被篡改则拒发并退回复审；人工改过的回复文案才是真正发出去的那份
**设计**：模型可以输出 SKIP 主动弃权（广告/辱骂类评论不值得回）；空评论直接忽略，不浪费模型调用

### T6.3 outbound 评论（引流）`[x]`
**交付物**：`src/core/outreach.ts` + daemon `outreach` 任务（**默认关闭**，需 `outreach.enabled: true`）
**验收**：✅ 14 测试通过
**为什么默认关闭**：这是 MediaBot 里唯一对**陌生人内容**动作的能力，风险性质和其他功能不同，不该开箱即用
**约束（全部有测试）**：
- 每平台日限从**数据库**统计而非内存，重启不会绕过；默认值刻意低于平台容忍线（X 20/天、小红书 10/天）
- 间隔**随机化**——固定每 N 分钟一条是平台最容易识别的自动化特征
- 同一条帖子永不重复评论（待审批的也算已触达，否则重跑会排重复）
- 模型可以输出 SKIP 主动弃权，prompt 里明确写了「泛泛的评论比不评论更糟，会消耗账号信誉」
- 仍然走同一个审批闸门，起草阶段绝不发送

---

## M7 — 目标层

### T7.1 指标采集 `[x]`
**交付物**：`src/core/metrics.ts` —— CLI 型采集器（`twitter.followers` / `twitter.posts`）+ 本地采集器（发布数 / 回复数 / 信号数）
**验收**：✅ 真实测得 followers=414、posts=551
**诚实边界**：小红书 `whoami` 不返回粉丝数、B站只返回等级——这两个平台**报「不可用」并说明原因，绝不编数字**。采集失败返回 `null` 而非 0，因为 0 会被当成真实测量值用来定目标

### T7.2 目标协商 `[x]`
**交付物**：`src/core/goals.ts` 的 `propose / measureBaseline / activate` + CLI `mediabot goal new|measure|start`
**验收**：✅ **无实测基线拒绝激活**（有测试断言）；无 target 同样拒绝。真实流程验证：基线 414 → 目标 500 → active

### T7.3 周期复盘与回测 `[x]`
**交付物**：`review()` / `progress()` + daemon `goals` 定时任务（默认周一 09:00）
**验收**：✅ 15 测试通过。预测误差按「上一轮预测 vs 本轮实测」计算；达成自动置 done（支持升高型和降低型目标）；过期未达成置 failed；**读数不可用时如实记录 null 且不判定失败**

---

## 里程碑依赖图

```
M0 骨架契约
 └─▶ M1 最小闭环（dry-run，无凭证可测）
      ├─▶ M2 中文平台发布 ──┐
      ├─▶ M3 daemon + Web UI ┤
      ├─▶ M4 监控层 ─────────┤
      ├─▶ M5 内容生产扩展 ────┤
      └────────────────────  ┴─▶ M6 反馈层 ─▶ M7 目标层
```

**M1 已完成（2026-07-24）——基础流程已跑通**——全链路可在无任何平台凭证的情况下端到端验证。
