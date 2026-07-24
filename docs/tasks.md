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

---

## M8 — 按验收标准补齐（2026-07-24 追加）

依据 [`acceptance.md`](acceptance.md)，规格见 [`spec.md`](spec.md) 附录 A。

### T8.1 `file` transport + Blog Publisher `[x]`
**交付物**：`src/providers/publisher/blog.ts` —— 写 markdown 到 Astro content collection + git commit/push
**接口变更**：`PublishTransport` 增加 `'file'`
**验收**：契约测试通过；写入的 frontmatter 能被 Astro 解析；dry-run 不写文件不 commit；同一 slug 重复发布不覆盖已有文章而是报错
**依据**：spec.md §A.4。**这是唯一允许审批后全自动的通道**——git 可撤回，误发一篇 blog 是 revert，误发一条小红书是永久的
**验收结果**：✅ 15 测试通过
**发现的关键约束**：两个 blog 是同一仓库的两个 collection（`blog` 技术 / `my` 生活），**各有不同的 category 枚举**。category 不在枚举里不是「这篇发不出去」，而是 **Astro 构建直接失败，整站文章一起挂**——所以枚举校验做在写文件之前，错误信息里列出允许值
**其他保证**：同名 slug 拒绝覆盖已发布文章；git push 失败时**保留已写入的文章**（删掉「清理」会丢内容），报 retryable 让人工接手
**契约套件抓到我自己的 bug**：声明了 `maxTextLength` 却没在 `validate()` 里执行——正是这个套件存在的意义

### T8.2 Telegram Publisher + Engagement `[x]`
**交付物**：`src/providers/publisher/telegram.ts` + `src/providers/engagement/telegram.ts`
**验收**：契约测试双槽位通过；**群消息只在「被 @ / 命令 / 匹配关键词」时才回**，其余一律不回（必须有测试）；dry-run 不发送
**参考**：`~/Dev/tools/telethon/CBots`（telethon 实现、命令分发、反广告准入）。**Bot API 走 HTTP 即可，不必引入 telethon**
**依据**：spec.md §A.2
**验收结果**：✅ 25 测试通过（双槽位契约 + 触发条件全覆盖）
**核心约束已钉死**：普通群消息**不回**——只在「被 @ / 回复了 bot / 命令 / 关键词命中 / 私聊」时才进队列。**另外不回其他 bot**——两个 bot 互相 at 会无限循环
**其他保证**：chat_id 来自配置而非生成内容（防止文案里的 chat_id 把帖子发到别的群）；Bot API 的 `ok:false`+HTTP 200 当失败处理；401 不重试（token 坏了重试没用）、403 被踢出群报 misconfigured（要人去重新加）
**offset 策略**：只在成功拉取后前进。推进 offset 等于向 Telegram 确认收到，中途崩溃会永久丢消息——id 命名空间化让重读无害，所以宁可重读不可丢

### T8.3 小红书视频 + 视频号 profile 填充 `[x]`
**交付物**：把 spec.md §A.3 的实测 selector 填进 `UPLOAD_PROFILE_TEMPLATES`
**接口变更**：`successIndicator` 支持 `url:` 前缀（两个平台都靠 URL 跳转判定成功，而非元素出现）
**验收**：`mediabot profiles` 显示 selector 齐全；**`verified` 仍保持 false** —— selector 来自第三方仓库的观察，未经本人在真实登录态下验证，规则不破例
**依据**：spec.md §A.3
**验收结果**：✅ 364 测试全绿
**接口扩展**：
- `successIndicator` 支持 `url:` 前缀——**这两个平台都靠 URL 跳转确认成功，不渲染成功标记**。用等元素的方式会一直超时，然后把成功的发布记成失败
- 新增 `loggedOutIndicator`（反向判定）——创作者后台通常是「出现登录框 = 未登录」，而不是标记已登录。两者都配时**反向的优先**：看到登录框是确凿的，而正向标记可能在鉴权完成前就渲染了
**已填 selector**：`xiaohongshu-video`、`wechat-channels`（抖音/快手仍是占位符，我没有这两个后台的观察值）
**`verified` 仍为 false，没有破例**——「看起来对」不等于「看着它跑通过」。一个为「看起来挺像」破例的规则就不再是规则了。`mediabot profiles` 现在会区分「缺 selector」和「selector 齐了但未验证」两种状态，后者不会再让你去找根本不缺的东西

### T8.4 Reddit 单账号 Source + Engagement `[x]`
**交付物**：`src/providers/source/reddit.ts`（`rdt search`）+ `src/providers/engagement/reddit.ts`（`rdt comment`）
**验收**：契约测试通过；**不实现 upvote**（即使单账号，自动投票仍属 vote manipulation）；日限默认 5，低于其他平台
**范围**：单个公开属于本人/组织的账号。多人设、自动点赞背书**不做**，理由见 acceptance.md §3
**验收结果**：✅ 18 测试通过；真实 Reddit 抓取验证（r/selfhosted）
**没实现 upvote，并有测试断言它不存在**——`rdt` 有投票能力，这里故意不接。自动投票即使单账号也属 vote manipulation，而且是 Reddit 反作弊最容易识别的行为
**日限设为 5**，低于其他平台一半——Reddit 社区对营销的反应比别处激烈得多，且版主是按模式封人而非按单条内容
**技术细节**：`rdt read` 返回嵌套 Listing，评论树要递归展开；`more` 类型是「还有 N 条」的占位符不是评论；Reddit id 带 `t1_` 类型前缀需要剥掉

### T8.5 内容形态适配 `[x]`
**交付物**：composer prompt 按平台注入形态要求（小红书重钩子和标签、公众号重结构、blog 重深度、X 重密度、Telegram 重简短）
**验收**：同一 brief 产出的各平台 variant **不是同一份文案的复制**——测试断言任意两版的正文相似度低于阈值
**依据**：acceptance.md §四.1，这是用户判断「好用」的第一条
**验收结果**：✅ 408 测试全绿；真实 Claude 验证
**实测产出**（同一 brief，四平台）：小红书 582 字第一人称钩子开头 / blog-tech 4066 字带 `##` 分节 / twitter 258 字结论前置 / reddit 2876 字**自动切英文**且用 `Context:` 开头（Reddit 惯例）。**两两相似度全部 < 0.1**
**运行时兜底**：光在 prompt 里要求「要不同」是请求不是保证，所以加了字符三元组相似度检测，模型偷懒复制时会告警。用字符三元组而非词元——中文没有空格，词元法会把两段完全不同的中文判成一样

**过程中修掉两个只有真跑才会暴露的 bug**：
1. **围栏解析在嵌套代码块处截断**——技术 blog 正文必然带 ```bash 代码块，非贪婪正则在 JSON 字符串内部的第一个 ``` 就断了。改成逐个尝试候选闭合位置，用「能否解析成 JSON」本身来消歧
2. **JSON 根本不适合装长文**——实测约 1/3 概率模型在字符串里写真实换行（`Invalid control character`）。改用分隔符格式 `<<<VARIANT platform=x>>> ... <<<END>>>`，正文不需要任何转义。改完连跑 5 次全成功（JSON 格式是 2/3）。**并且发现是我 prompt 自相矛盾**——开头写着「Reply with ONE fenced json block」，尾部才是新格式，模型听最前面那句

### T8.6 端到端验收演练 `[x]`
**依赖**：T8.1–T8.5
**交付物**：一次真实全链路：抓取 → 生成多平台变体（含配图/成片）→ 审批队列 → dry-run 发布，产出可人工检查的报告
**验收**：对照 acceptance.md §四 的五条标准逐条给出证据
**交付物**：`scripts/acceptance-drill.ts`（`pnpm drill`，加 `--media` 含出图/配音/成片）——仓库里可重复运行的脚本，不是一次性验证。全程 dry-run，可安全重跑
**实测结果**：
- ✅ 多平台形态正确：5/5 平台产出，最高两两相似度 0.068（阈值 0.75），长度 185–6012 字
- ✅ 各平台校验通过率：5/5 通过各自**真实**平台限制
- ✅ 不出事故：未批准发布 0 条、重放发布 0 条、批准后被篡改 → 拒绝并退回复审
- ⏳ 回复质量 / 每日耗时 / 账号安全：**这三条一次脚本运行判定不了**，是关于数周真实使用的主张，标成通过只是自欺

**演练发现并修掉一个真实缺陷**：composer 不知道平台**硬限制**，生成的内容到校验才被拒——白烧一次模型调用，那个平台还静默没内容。首轮 5 个变体只过了 3 个（小红书标题超 20 字、Twitter 中文 283 字≈500 加权单位超 280）。把硬限制写进形态指引并排在语气之前后，变成 5/5
**演练自身也修了一处**：原来用 dry-run publisher 的通用限制（2000 字），会把合法的 7000 字技术博客判为超长——测的是假限制。改成注入各平台真实限制

### T8.7 提交 PR `[ ]`
**依赖**：T8.1–T8.6 全绿
**交付物**：feature 分支 → PR 到 main，说明本轮交付、未完成项、以及需要用户实测的部分
