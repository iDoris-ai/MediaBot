# MediaBot 规格说明

> 前置：[`research.md`](research.md)（调研与 license 审计）·[`architecture.md`](architecture.md)（契约与槽位）
> 本文定义：数据结构、状态机、上下游衔接、幂等与错误处理、测试策略。

## 一、产品定义

**MediaBot 是个人 / 社区 / 公司的媒体工作台**——覆盖目标、内容、发布、反馈、监控五个环节，跑在 Claude Code 之上，本地自托管，Apache-2.0。

设计立场：
- **外部有成熟能力就接入，没有就自己写**（见 architecture.md §2 的三种接入方式）
- **所有对外动作过审批闸门**，监控层只读
- **数据不出本机**

## 二、数据模型

SQLite（`better-sqlite3`，同步 API，WAL 模式）。所有时间戳为 Unix 毫秒整数。所有 JSON 字段以 TEXT 存储。

### 2.1 goals — 目标层

```sql
CREATE TABLE goals (
  id                   TEXT PRIMARY KEY,
  title                TEXT    NOT NULL,
  metric               TEXT    NOT NULL,   -- organic_clicks | followers | leads | ...
  baseline             REAL,
  baseline_measured_at INTEGER,
  target               REAL,
  deadline             INTEGER,
  cadence              TEXT,               -- cron 表达式，复盘节奏
  state                TEXT    NOT NULL,   -- draft|active|paused|done|failed
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE TABLE goal_checks (
  id         TEXT PRIMARY KEY,
  goal_id    TEXT    NOT NULL REFERENCES goals(id),
  measured   REAL,                          -- 本次实测
  predicted  REAL,                          -- 上一轮对本次的预测，用于回测准确度
  note       TEXT,
  checked_at INTEGER NOT NULL
);
CREATE INDEX idx_goal_checks_goal ON goal_checks(goal_id, checked_at DESC);
```

`predicted` 是关键字段：每轮不仅记录实测值，还记录上一轮的预测，用来评估 agent 判断力是否可信（NotFair 模式）。

### 2.2 source_items — 情报输入

```sql
CREATE TABLE source_items (
  id           TEXT PRIMARY KEY,           -- "<provider_id>:<external_id>"，天然去重
  provider_id  TEXT    NOT NULL,
  kind         TEXT    NOT NULL,           -- trend|news|competitor|comment
  title        TEXT    NOT NULL,
  url          TEXT,
  summary      TEXT,
  score        REAL,
  locale       TEXT,
  published_at INTEGER,
  raw          TEXT,                       -- JSON，原始响应，便于日后重解析
  fetched_at   INTEGER NOT NULL
);
CREATE INDEX idx_source_items_fetched ON source_items(fetched_at DESC);
CREATE INDEX idx_source_items_kind    ON source_items(kind, published_at DESC);
```

主键设计为 `provider:external_id`，使重复抓取天然幂等（`INSERT OR IGNORE`）。

### 2.3 drafts / draft_variants — 内容

```sql
CREATE TABLE drafts (
  id          TEXT PRIMARY KEY,
  goal_id     TEXT REFERENCES goals(id),
  brief       TEXT    NOT NULL,            -- JSON ContentBrief（含 source_item ids）
  composer_id TEXT    NOT NULL,
  state       TEXT    NOT NULL,            -- composing|ready|discarded
  error       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE draft_variants (
  id         TEXT PRIMARY KEY,
  draft_id   TEXT    NOT NULL REFERENCES drafts(id),
  platform   TEXT    NOT NULL,
  title      TEXT,
  body       TEXT    NOT NULL,
  media      TEXT,                         -- JSON MediaRef[]
  meta       TEXT,                         -- JSON，平台专属：话题/标签/合集/定位
  validation TEXT,                         -- JSON ValidationResult（校验快照）
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_variants_draft ON draft_variants(draft_id);
```

### 2.4 accounts — 账号与凭证

```sql
CREATE TABLE accounts (
  id             TEXT PRIMARY KEY,
  platform       TEXT    NOT NULL,
  provider_id    TEXT    NOT NULL,
  transport      TEXT    NOT NULL,         -- api|browser|extension
  display_name   TEXT,
  credential_ref TEXT,                     -- 指向 keychain / 加密文件的引用
  state          TEXT    NOT NULL,         -- active|needs_reauth|disabled
  posting_times  TEXT,                     -- JSON，默认发布时段
  settings       TEXT,                     -- JSON，平台专属配置
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_accounts_platform_name ON accounts(platform, display_name);
```

**凭证绝不明文入库**：`credential_ref` 指向 OS keychain 条目或加密文件，DB 只存引用。

### 2.5 approvals — 审批闸门（核心）

```sql
CREATE TABLE approvals (
  id            TEXT PRIMARY KEY,
  kind          TEXT    NOT NULL,          -- publish|reply
  ref_id        TEXT    NOT NULL,          -- draft_variant.id | comment.id
  state         TEXT    NOT NULL,          -- pending|approved|rejected|expired
  payload       TEXT    NOT NULL,          -- JSON 内容快照
  payload_hash  TEXT    NOT NULL,          -- 快照哈希，执行前校验
  scheduled_for INTEGER,                   -- 批准后何时执行
  decided_by    TEXT,
  decided_at    INTEGER,
  reason        TEXT,                      -- 拒绝原因 / 修改说明
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_approvals_state ON approvals(state, created_at DESC);
```

**`payload` + `payload_hash` 是不可变快照**：人批准的必须正好是人看到的。执行前重算哈希，不匹配则拒绝执行并重新入队——防止"批准后内容被改"。

### 2.6 posts — 发布记录

```sql
CREATE TABLE posts (
  id               TEXT PRIMARY KEY,
  draft_variant_id TEXT REFERENCES draft_variants(id),
  approval_id      TEXT REFERENCES approvals(id),
  platform         TEXT    NOT NULL,
  account_id       TEXT    NOT NULL REFERENCES accounts(id),
  state            TEXT    NOT NULL,       -- queued|publishing|published|failed|dead
  platform_post_id TEXT,
  url              TEXT,
  scheduled_for    INTEGER,
  published_at     INTEGER,
  attempts         INTEGER NOT NULL DEFAULT 0,
  error            TEXT,
  idempotency_key  TEXT    NOT NULL UNIQUE,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX idx_posts_state_sched ON posts(state, scheduled_for);
```

**`idempotency_key`（UNIQUE）是防重复发布的最后一道锁**——daemon 崩溃重启后重放任务时，唯一约束保证同一内容不会二次发出。取值：`sha256(account_id + draft_variant_id + scheduled_for)`。

### 2.7 comments — 反馈

```sql
CREATE TABLE comments (
  id                TEXT PRIMARY KEY,      -- "<platform>:<external_id>"
  post_id           TEXT REFERENCES posts(id),
  platform          TEXT    NOT NULL,
  author            TEXT,
  body              TEXT,
  published_at      INTEGER,
  state             TEXT    NOT NULL,      -- new|drafted|approved|replied|ignored
  reply_draft       TEXT,
  reply_platform_id TEXT,
  fetched_at        INTEGER NOT NULL
);
CREATE INDEX idx_comments_state ON comments(state, published_at DESC);
```

### 2.8 runs — 可观测性

```sql
CREATE TABLE runs (
  id          TEXT PRIMARY KEY,
  kind        TEXT    NOT NULL,            -- source_poll|compose|publish|engage|goal_check
  provider_id TEXT,
  ref_id      TEXT,
  state       TEXT    NOT NULL,            -- running|ok|error
  detail      TEXT,
  cost_usd    REAL,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX idx_runs_started ON runs(started_at DESC);
```

## 三、业务流程状态机

```
   [SourceProvider.fetch]            [Goal]
            │                           │
            ▼                           │
      source_items ────────┬────────────┘
                           ▼
                    ContentBrief
                           │
                  [ComposerProvider.compose]
                           ▼
                  drafts(composing) ──error──▶ drafts(discarded)
                           ▼
                    drafts(ready)
                           ▼
                    draft_variants
                           │
                 [PublisherProvider.validate]
                           ▼
                  approvals(pending)
                           │
              ┌────────────┴────────────┐
          approved                   rejected
              │                          ▼
              ▼                     （回到 compose 或丢弃）
        posts(queued)
              │  [scheduler 到点 + payload_hash 校验]
              ▼
       posts(publishing)
              │
      ┌───────┴────────┐
  published          failed ──retry(指数退避,≤3)──▶ posts(dead)
      │
      ▼
[EngagementProvider.listComments]
      ▼
 comments(new) ─[起草]─▶ comments(drafted) ─▶ approvals(pending) ─▶ comments(replied)
```

### 上下游衔接契约

| 上游 | 产物 | 下游 | 衔接约束 |
|---|---|---|---|
| SourceProvider | `SourceItem[]` | ContentBrief | 只读；主键去重；不得直接触发发布 |
| Goal | `goal.title/metric` | ContentBrief | 可选；无目标时 brief 仍可成立 |
| ComposerProvider | `Draft.variants[]` | validate | 每个目标平台必须有对应 variant，否则该平台跳过 |
| validate | `ValidationResult` | approvals | 校验失败不入审批队列，回写 `draft_variants.validation` |
| approvals(approved) | `payload` 快照 | posts | 执行前必须校验 `payload_hash` |
| posts(published) | `platform_post_id` | EngagementProvider | 评论轮询以此为锚点 |
| comments | 回复草稿 | approvals | 复用同一审批闸门，`kind='reply'` |

## 四、错误处理与幂等

| 场景 | 策略 |
|---|---|
| Source 抓取失败 | 记 `runs(error)`，跳过本轮，不影响其他 provider |
| 重复抓到同一条 | 主键 `provider:external_id` + `INSERT OR IGNORE` |
| Compose 失败 | `drafts.state=discarded` + `error`，不重试（避免烧 token）|
| 发布失败 | 指数退避重试 ≤3 次（1min/5min/25min），超限转 `dead` 并告警 |
| daemon 重启后重放 | `posts.idempotency_key` UNIQUE 约束兜底 |
| 批准后内容被改 | `payload_hash` 校验失败 → 拒绝执行 → 重新入审批队列 |
| 凭证过期 | `accounts.state=needs_reauth`，暂停该账号任务并告警 |
| 平台限流 | 每 provider 独立速率窗口，超限则顺延而非丢弃 |

## 五、测试策略

| 层级 | 范围 | 要求 |
|---|---|---|
| **单元测试** | 纯函数：校验、幂等键、退避、哈希 | 必须 |
| **契约一致性测试（Conformance Kit）** | 任一 provider 实现 | **必须**——见下 |
| **集成测试** | daemon 调度 + SQLite 状态流转 | 用 dry-run provider，无需真实凭证 |
| **E2E** | 真实平台发布 | 手动 / 打标签，不进 CI |

### Conformance Kit（关键设计）

因为 provider 是外部可接入的，必须提供一套**契约一致性测试套件**，任何第三方实现自己跑一遍即可自证兼容：

```
pnpm test:conformance --provider ./my-provider.ts --slot publisher
```

套件校验：接口方法齐全、错误类型正确、幂等性、`limits` 声明与实际行为一致、审批边界未被绕过（Source 不得调用写方法）。

**这是"外部可接入"能否成立的关键**——没有一致性测试，插件生态会变成一堆行为不一致的实现。

## 六、工程约定

- **包管理**：pnpm
- **语言**：TypeScript strict，CommonJS + tsx（与 Heinu1 一致）
- **DoD**：类型检查通过 + 单测通过 + 契约测试通过（涉及 provider 时）+ 文档同步更新
- **CI**：GitHub Actions —— typecheck、unit、conformance（dry-run providers）

---

# 附录 A：M8 能力扩展规格（2026-07-24 追加）

依据 [`acceptance.md`](acceptance.md) 的用户验收标准倒推。

## A.1 新增 transport

`PublishTransport` 增加一个取值：

```typescript
type PublishTransport = 'api' | 'cli' | 'browser' | 'extension' | 'file';
```

`file` —— 产物是写进本地仓库的文件（blog 的 markdown），发布动作 = 写文件 + git commit + push。
它和其他 transport 的本质区别：**可撤回**。所以 blog publisher 是唯一允许在审批后自动完成全流程的通道。

## A.2 Telegram：一个平台，两个槽位

Telegram 群机器人同时落在两个契约上，不需要新接口：

| 需求 | 落到哪个槽位 | 说明 |
|---|---|---|
| 群内定时发信息 | `PublisherProvider` | `platform: 'telegram'`，`publish()` = 发群消息 |
| 自动回复群里的信息 | `EngagementProvider` | `listComments()` = 拉未读群消息，`reply()` = 回复某条 |

**数据结构复用**：群消息映射成 `Comment`，`postId` 用群 id，`id` 用 `telegram:<chat_id>:<message_id>`。

**关键约束**：群里自动回复的触发面比帖子评论大得多——不能所有消息都回。触发条件必须显式：
- 被 @ 提及
- 命令消息（`/xxx`）
- 匹配预设关键词

**其余消息一律不回**，且这条要有测试。一个逢消息必回的群机器人会被踢出群。

## A.3 小红书视频 / 视频号：填充已有的 browser-publisher

不需要新代码结构——T2.6 的 `BrowserPublisher` 就是为此设计的，现在补上实测 selector。

**小红书视频**（`creator.xiaohongshu.com`）：

| 字段 | 值 |
|---|---|
| uploadUrl | `https://creator.xiaohongshu.com/publish/publish?from=homepage&target=video` |
| fileInput | `input[type="file"]` |
| titleInput | `input[placeholder*="填写标题"]`（≤20 字） |
| bodyInput | `p[data-placeholder*="输入正文描述"]` |
| successIndicator | URL 匹配 `**/publish/success?**` |
| loginUrl | `https://creator.xiaohongshu.com` |
| 未登录标志 | 出现 `div[class*='login-box']` |

**视频号**（`channels.weixin.qq.com`）：

| 字段 | 值 |
|---|---|
| uploadUrl | `https://channels.weixin.qq.com/platform/post/create` |
| fileInput | `input[type="file"]` |
| bodyInput | `div.input-editor` |
| publishButton | `div.form-btns button:has-text("发表")` |
| draftButton | `div.form-btns button:has-text("保存草稿")` |
| successIndicator | URL 匹配 `**/post/list**` |
| 未登录标志 | `div.title-name:has-text("微信小店")` 或出现「扫码登录」 |

**selector 来源说明**：观察自 `dreammis/social-auto-upload` 与 `Stevewu422/auto-weixin-video-skill`。两者均无 LICENSE，因此**只取 selector 这一事实**（某第三方页面的 DOM 结构是客观事实，非该作者的创作表达），实现完全自写。仍然遵守「未经本人实测不设 `verified: true`」的规则——这些值需要在真实登录态下验证一次。

**成功判定改为 URL 匹配**：现有 `successIndicator` 只支持元素选择器，需扩展为支持 `url:` 前缀。

## A.4 Blog 发布（技术 / 生活）

**transport**: `file`

流程：
```
DraftVariant → frontmatter + markdown → 写入 <repo>/src/content/blog/<slug>.md
            → git add / commit / push → 返回预期 URL
```

**数据结构**（`variant.meta`）：
```typescript
{
  repo: string;            // 仓库路径
  collection?: string;     // 默认 'blog'
  slug?: string;           // 缺省从标题生成
  frontmatter?: Record<string, unknown>;  // 合并进 YAML 头
  urlPattern?: string;     // 例如 'https://blog.x.cv/blog/{slug}/'
}
```

**为什么它可以自动完成全流程**：git 可撤回。误发一篇 blog 是 `git revert` + 重新部署；误发一条小红书是永久的。这个差别决定了审批之后的自动化程度可以不同。

## A.5 Reddit 单账号

**明确范围**：一个公开属于本人/组织的账号。**不做多人设、不做自动点赞背书**（理由见 acceptance.md §3）。

| 需求 | 槽位 | 实现 |
|---|---|---|
| 搜索相关讨论 | `SourceProvider` | `rdt search` |
| 读帖子和评论 | `SourceProvider` | `rdt read` |
| 起草回复 | 复用 `EngagementRunner` | 走同一审批闸门 |
| 发表评论 | `EngagementProvider` | `rdt comment` |

**额外约束**（Reddit 社区对营销尤其敏感）：
- 日限比其他平台更低（默认 5）
- prompt 中必须要求：只在能提供具体信息时回复，涉及自身产品时主动披露身份
- 不实现 `upvote`——即使单账号，自动投票也属于 vote manipulation

## A.6 上下游衔接

```
Source（rdt search / xhs search / twitter search / RSS / MCP）
   ↓ source_items
Compose（Claude 文案 + FLUX 配图 + TTS 旁白 + ffmpeg 成片）
   ↓ draft_variants（每平台一版）
Validate（各 publisher 的 limits）
   ↓
Approval（唯一闸门）
   ↓
Publish
   ├── file      → blog（可撤回，审批后全自动）
   ├── api       → 公众号草稿 / Telegram 群消息
   ├── cli       → 小红书图文 / X / B站动态 / Reddit 评论
   └── browser   → 小红书视频 / 视频号 / 抖音 / 快手
   ↓ posts
Engage（评论轮询 → 起草 → 审批 → 回复）
   ↓ comments
Goals（指标采集 → 复盘 → 回测）
```
