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

### T2.1 浏览器会话管理 `[ ]`
**依赖**：T0.3
**交付物**：`src/core/browser.ts` —— Playwright 上下文管理、cookie 持久化（加密）、登录态探活
**验收**：登录态可保存/恢复；失效时账号置 `needs_reauth`
**约束**：首次登录需 GUI 环境（见 architecture.md §8）

### T2.2 凭证保管 `[ ]`
**依赖**：T0.3
**交付物**：`src/core/credentials.ts` —— OS keychain 优先，回退加密文件；DB 只存 `credential_ref`
**验收**：单测——DB 中检索不到任何明文 token/cookie

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

### T2.6 抖音 / 视频号 / 快手 / B站视频投稿 `[ ]`
**依赖**：T2.1 Playwright 会话 + T2.2 凭证保管
**说明**：经核查这四个平台确实没有可用 CLI，是目前唯一必须走 ③ 自研 Playwright 的部分

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

### T3.4 IM 推送适配器（可选）`[ ]`
**依赖**：T3.1
**交付物**：`src/providers/notify/` —— 微信（对接 Heinu1）/ Telegram，推审批请求，支持手机端批准
**验收**：审批入队后收到推送；回复指令能改变审批状态

---

## M4 — 监控层

### T4.1 MCP 客户端接入层 `[ ]`
**依赖**：T0.2
**交付物**：`src/core/mcp.ts` —— 把任意 MCP server 包装成 `SourceProvider`
**验收**：配置即接入，无需为每个 MCP 写代码

### T4.2 Google Trends `[ ]`
**依赖**：T4.1
**交付物**：配置接入 `purahmanian/google-trends-mcp`
**验收**：给定关键词返回趋势数据并落 `source_items`

### T4.3 CLI 搜索型 Source `[x]`
**交付物**：`src/providers/source/cli-search.ts` —— 小红书 / Twitter / B站 关键词监控，共用一套映射框架
**验收**：✅ 14 测试通过（含 eyes-not-hands 契约）；真实小红书抓取验证通过
**说明**：agent-reach 本身是路由器/安装器，实际抓取由底层 CLI 完成，因此直接适配底层 CLI 更直接。单个关键词失败不影响其他关键词；登录过期则中止而非静默返回空。

### T4.4 情报简报 `[x]`
**交付物**：`src/core/briefing.ts` + daemon `briefing` 定时任务（默认 07:30）
**验收**：✅ 8 测试通过；**有测试断言简报不创建 drafts/approvals/posts 任何一行**——监控只做眼睛不做手
**降级设计**：模型不可用时输出原始信号列表，不因此丢掉整轮监控结果

### T4.5 竞品 / SEO / 社交监听 `[ ]`
**依赖**：T4.1
**交付物**：配置接入 `unifapi-agent/agents`（MCP）
**验收**：只读；产物入 `source_items`

---

## M5 — 内容生产扩展

### T5.1 配图 `[ ]`
**依赖**：T0.2
**交付物**：本地 flux-gen（FLUX.2 Klein 4B MLX）包装成 ComposerProvider
**验收**：按 brief 产图并写入 `MediaRef`

### T5.2 TTS / 配音 `[ ]`
**依赖**：T0.2
**交付物**：CLI 适配 MOSS-TTS / LuxTTS 等
**验收**：文本转音频，产物可被视频 composer 消费

### T5.3 短视频生成 `[ ]`
**依赖**：T5.2, T4.3
**交付物**：CLI 适配 `AIDC-AI/Pixelle-Video` 或 `FireRed-OpenStoryline`
**验收**：脚本 → 成片；`limits.video` 与目标平台匹配

### T5.4 发布物料流水线 `[ ]`
**依赖**：T0.2
**交付物**：CLI 适配 `ucsandman/marketing-studio`（MIT）
**验收**：产出封面 / 切片 / OG 图

### T5.5 MultiPost 插件通道 `[ ]`
**依赖**：T0.2
**交付物**：接入 `MultiPost-Extension`（Apache-2.0）作为 `transport='extension'` 的 publisher
**验收**：一次投递覆盖 10+ 平台

---

## M6 — 反馈层

### T6.1 评论轮询 `[ ]`
**依赖**：T2.x, T3.1
**交付物**：`EngagementProvider` 实现，以 `platform_post_id` 为锚点拉评论
**验收**：新评论入 `comments(new)`，重复轮询不产生重复行

### T6.2 回复起草 + 审批 `[ ]`
**依赖**：T6.1, T1.5
**交付物**：Claude 起草回复 → 复用审批闸门（`kind='reply'`）
**验收**：批准后发出并置 `replied`；拒绝不发送

### T6.3 outbound 评论（引流）`[ ]`
**依赖**：T6.2
**交付物**：主动在他人内容下评论，含速率限制与质量门槛
**验收**：每平台日限生效；随机间隔而非固定节奏

---

## M7 — 目标层

### T7.1 指标采集 `[ ]`
**依赖**：T4.1
**交付物**：从 Search Console / 平台后台 / 站点分析采集 `metric`
**验收**：能测得基线并落 `goals.baseline`

### T7.2 目标协商 `[ ]`
**依赖**：T7.1, T1.1
**交付物**：对话式确认目标（核实基线 → 商定 target/deadline/cadence）
**验收**：产出 `goals(active)`；无实测基线不允许激活

### T7.3 周期复盘与回测 `[ ]`
**依赖**：T7.2
**交付物**：按 cadence 复盘，记录 `measured` 与上轮 `predicted`
**验收**：能输出预测准确度；目标达成/失败自动置态

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
