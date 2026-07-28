# MediaBot 开源工具全景调研

调研日期：2026-07-24。三个渠道：① 已发布博客（blog.mushroom.cv） ② 本地博客仓库历史草稿（`~/Dev/mycelium/blog`） ③ GitHub 搜索（`gh search repos`）。共发现并克隆 21 个参考仓库到本仓库 `research/refs/`（已 gitignore，仅本地参考）。

## 一、五步框架

个人/组织/社区/公司做媒体运营，本质是五个环节的闭环：

1. **目标** —— 想要什么结果（涨粉/流量/线索），阶段性核实进展
2. **内容** —— 生成什么内容
3. **发布** —— 怎么发出去，发到哪些平台
4. **反馈** —— 别人对内容的反应怎么处理（评论/私信回复）
5. **监控** —— 后置环节，跟踪行业动态/竞品/趋势，反哺下一轮内容

这个框架和 2026-07-22 发布的博客文章《把市场部外包给 Agent：没有市场团队的技术型创业公司增长指南》（`startup-ai-marketing-agent-system-no-team-needed.md`）里的五类 Agent（X 回复、LinkedIn 回复、博客评论、内容生成、意图信号监控）高度重合，但有一处关键语义差异：文章的"回复 Agent"是主动去别人帖子下评论引流（outbound 增长战术），MediaBot 的"反馈"环节指的是回复自己帖子下的评论/私信（inbound 客服维系）——两者都要做，是不同功能。

## 二、21 个仓库全景表

### ② 内容生成

| 仓库 | ★ | License | 备注 |
|---|---|---|---|
| langchain-ai/social-media-agent | 2.7k | MIT | LangGraph 策展+起草架构参考 |
| cgallic/kai-cmo-harness | 34 | MIT | `kai/social/caption_engine.py`，47 个 `/kai` 命令含内容生产 |
| SaigonXIII/evc | 53 | MIT | Claude Code 42 命令工作区，含 content-engine |

### ③ 发布

| 仓库 | ★ | License | 平台覆盖 |
|---|---|---|---|
| gitroomhq/postiz-app | 33.7k | **AGPL-3.0** | 30+ 欧美平台，**零中文平台**；数据模型（Post/Integration 两表）和 `SocialProvider` 插件接口设计非常干净，值得借鉴思路 |
| gitroomhq/postiz-agent | 375 | AGPL-3.0 | 专门桥接 Claude/OpenClaw 的 CLI |
| dreammis/social-auto-upload | 13.7k | **无 LICENSE** | 抖音/小红书/视频号/快手/B站/YouTube，Playwright + cookie 登录，目前唯一覆盖全部主流中文平台的方案 |
| leaperone/MultiPost-Extension | 2.9k | Apache-2.0 | 10+ 平台，浏览器插件，复用已登录 session，零 API Key |
| inovector/mixpost | 3.4k | MIT | Laravel 自托管调度器，另一套数据模型参考 |
| mguozhen/multi-platform-publisher | 7 | MIT | 一条命令发 X/LinkedIn/微信/小红书 |
| changyikang/kay-video-upload | 5 | MIT | 抖音/视频号/快手短视频 |
| kai-cmo-harness `scripts/publish/` | — | MIT | Ghost/Webflow/WordPress（西方 CMS，非社媒）|

### ④ 反馈（评论/互动）

| 仓库 | ★ | License | 备注 |
|---|---|---|---|
| edofransisco011/Smb-Marketing-Agent | 7 | 无 LICENSE | **"Echo" Reputation Agent**——专门分析并起草客户评论回复，明确面向中小商户，manager-worker 多 agent 架构，是"反馈"环节最贴合的参考 |

### ⑤ 监控

| 仓库 | ★ | License | 备注 |
|---|---|---|---|
| unifapi-agent/agents | 527 | MIT | **"eyes not hands"**——SEO/GEO/本地SEO/KOL定价/社交监听/竞品情报，只读不发，MCP 架构，多客户端（Claude/ChatGPT/Codex/OpenClaw）兼容 |
| kai-cmo-harness `kai/watchers/` + `scripts/reddit_monitor/` | — | MIT | 广告花费/排期/社媒新鲜度监控 + Reddit 关键词监听 |

搜索"trend detection agent"等关键词，结果全是 0-13★ 的个人玩具项目，**确认这是市面上覆盖最弱的一环**——现有方案要么窄（LinkedIn 招聘信号→销售线索），要么是广告花费类运维监控，没有通用的"新闻/趋势/舆情"内容型监控开源方案。

### ① 目标（策略层）

| 仓库 | ★ | License | 备注 |
|---|---|---|---|
| nowork-studio/NotFair | **3.2k** | MIT | 目标不是配置项，是一个 Agent："帮我把自然流量 3 个月涨 30%" → agent 核实基线、和用户在对话里商定可验证目标、按周期循环执行 + 用实际数据回测预测准确度。直接跑在 Claude Code/Codex 登录态之上，不用额外 API Key，本地 SQLite 存状态 |

### 其余参考（价值较低或方向偏离，仅记录不深入）

Ahil-NS/marketing-agent-teams（无 license）、Dataslayer-AI/Marketing-skills（MCP 连接 50+ 广告/分析平台）、Hk669/AI-Marketing-Agents（无 license）、telexintegrations/email-marketing-agent、lucaswalter/reddit-marketing-agent（无 license）、ucsandman/marketing-studio（Claude Code 技能，生成发布物料）、LocoreMind/locoagent、leamsigc/MagicSync（无 license）。

## 三、四个最值得借鉴的架构模式

1. **Postiz 的 Post/Integration 两表数据模型** —— 发布记录和账号凭证解耦，`additionalSettings` JSON 字段兼顾平台差异化配置，通用性强。(AGPL，只抄接口形状不抄代码)
2. **kai-cmo-harness 的 Claude Code 插件分发方式** —— `/plugin marketplace add` 一行安装，`/kai:xxx` 命令直接可用，零配置零 API Key，这是目前"跑在 Claude Code 上的 agent"最成熟的分发范式。(MIT，可直接参考甚至复用)
3. **NotFair 的目标协商循环** —— 测基线 → 和用户在对话里谈妥可验证目标 → 按节奏执行 → 用实际数据回测每次预测。这填上了"①目标"环节——目标不该是静态配置，该是一个持续对话的 agent。(MIT，可直接参考)
4. **unifapi-agent 的"eyes not hands"边界** —— 监控类 agent 明确只读不发，避免"监控信号自动触发发帖"这种失控链路。(MIT)

## 四、两个结构性空白（MediaBot 的立足点）

1. **中文平台发布** —— Postiz、kai-cmo-harness、NotFair、unifapi-agent 这些做得最成熟的框架，没有一个支持小红书/公众号/视频号/抖音。中文平台的发布能力只存在于 star 数低、license 缺失的小项目。
2. **通用态势监控** —— 五个环节里唯一没有成熟开源方案的，现有监控要么窄要么是运维类，不是内容型的新闻/趋势/舆情监控。

## 五、License 策略（MediaBot = Apache-2.0，全新实现）

- **能直接参考代码**：MultiPost-Extension、langchain-ai/social-media-agent、mixpost、kai-cmo-harness、evc、NotFair、unifapi-agent、multi-platform-publisher、kay-video-upload、marketing-studio、Dataslayer-AI/Marketing-skills（均 MIT/Apache-2.0）
- **只能参考接口/数据结构设计，代码要重写**：postiz-app、postiz-agent（AGPL-3.0，copyleft 会传染，抄了就得跟着开源成 AGPL）
- **只能参考思路，不能碰代码**：social-auto-upload、MagicSync、Ahil-NS/marketing-agent-teams、Hk669/AI-Marketing-Agents、lucaswalter/reddit-marketing-agent、Smb-Marketing-Agent（均无 LICENSE 文件，法律默认保留所有权利）

## 六、提案架构

```
MediaBot (Apache-2.0)
跑在 Claude Code 之上 —— 模型可切 Kimi/GLM/DeepSeek，
                        复用 ANTHROPIC_BASE_URL（Heinu1 的 spawn-claude 架构本来就免费兼容这套）

① 目标层   仿 NotFair：目标协商 agent，本地 DB 存基线/目标/周期复盘
② 内容层   素材库 + 抓取信息 → Claude 生成初稿（图文/短视频脚本）
③ 发布层   数据模型仿 Postiz（Post/Integration），适配器分两类：
           · 官方 API 类（西方平台，接口形状仿 SocialProvider）
           · Playwright + Cookie 类（中文平台，仿 social-auto-upload，自己重写）
④ 反馈层   仿 Smb-Marketing-Agent 的 Echo Reputation Agent：
           inbound（自己帖子评论回复）+ outbound（引流式评论）两种模式
⑤ 监控层   仿 unifapi-agent 的"eyes not hands"边界：
           抓取趋势/新闻/竞品动态，只读，人工审阅后才转 ③
分发方式   仿 kai-cmo-harness：Claude Code 插件，零配置起步
```

## 七、参考仓库本地路径

克隆在本仓库 `research/refs/`（已加入 `.gitignore`，不随仓库提交，仅供本地查阅源码）。共 22 个仓库（含 §八 追加的 openworker），约 586MB。

## 八、追加调研：andrewyng/openworker（2026-07-25）

来源：blog.mushroom.cv 文章《Andrew Ng 的 OpenWorker》。**MIT License（Copyright 2024 Andrew Ng）——可以直接改编代码，只需保留版权声明**，比本文档里那批 AGPL/无 license 的仓库宽松得多。技术栈 Tauri 2 + React 外壳 + 本地 Python FastAPI agent server（`coworker/` 约 32k 行），所以"直接抄"实际是照着重写成 TS，不是复制文件。

它和 MediaBot 不是竞品：OpenWorker 是通用桌面 coworker（交付物导向：给你一份成稿、发一条 Slack、改一个日程），MediaBot 是单一负载（媒体运营）。**重合点恰好是最难做对的那部分——人机边界**，而它在这一块比 MediaBot 细。

### 8.1 值得借鉴（按价值排序）

1. **分级风险模型 + 权限模式（`coworker/risk.py`、`permissions.py`）**
   每个工具调用先归入 `read` / `write_local` / `exec` / `external` 四类，再由 5 档模式（discuss / plan / interactive / auto / custom）裁决 allow / deny / ask。关键设计是**风险是工具声明的属性，由单一 `classify()` 读取**，而不是散落在各处的 `if tool in WRITE_TOOLS`（它的注释明确说这是重构掉的旧写法）。
   对 MediaBot：目前是二元的——对外动作全需审批，其余不管。但实际上已经有隐含分级（blog 可 `git revert`、公众号只建草稿、小红书不可撤回），这些判断散在各 provider 里。CLAUDE.md 写的"审批不可全局关闭，可按平台放宽"**至今没有落地机制**，这就是那个机制该有的形状。

2. **绑定精确目标的常驻授权（`permissions.py::standing_rule_candidate`、`automation/models.py::grant_entries`）**
   "以后都允许"只能绑定到**一个确切目标**（`"send_message #general"`），且只对 `external` 风险开放——`exec` 永远问，写本地文件永远问。规则存在自动化任务记录上，**删任务连带撤销**；`grant_entries` 是 fail-closed 的白名单校验，只有声明了 target 参数的工具才可能被授权。
   对 MediaBot：这才是"按平台放宽"的正确粒度——不是放宽"小红书发布"，是放宽"发布到 blog-tech 这个仓库"。前者不可撤回，后者 `git revert` 就完事。

3. **收件箱绑定 + 回复即审批（`inbox_routing.py`）**
   审批项投递到 Slack/Telegram 时把 item id 嵌进消息（`[ow:<id>]`），人的回复按 id 关联回来，解析 allow / deny / 自由文本答案。in-app 永远是记录源，IM 只是同一批 item 的另一个传输通道。
   对 MediaBot：**最直接可用的一条**。现在推送只是通知（"3 条草稿待审批"），人还得去开 localhost:7788；而 Telegram 侧收发能力已经有了。这直击 acceptance.md §四.3"每天 ≤30 分钟且全花在审阅上"。
   ⚠️ **安全前提**：群里任何人回复都能批准是不可接受的，必须绑定到所有者的 user id，且这条要写成不变量而不是配置。

4. **审计参数脱敏（`audit.py::_sanitize_args`）**
   token/secret/password/api_key/access_token 一律 `[redacted]`，body/content/html 截断，`browser_type` 的 `text` 参数当输入内容脱敏。
   对 MediaBot：`runs` 表现在只存一个 `detail` 字符串。**将来一旦开始记 provider 调用参数，必须先有这套脱敏**，否则审计日志本身变成凭证泄露面。这段可以直接改编（MIT）。

5. **"人在不在"与"授权上限"分离（`unattended.py`）**
   unattended 只改**去哪儿找人**（转收件箱、挂起等答复），**不改自治天花板**——那是权限模式的事。
   对 MediaBot：daemon 天生就是无人值守的，正好用这个区分说清一件事：定时跑 ≠ 提高授权，approve 永远是人的动作。这是概念澄清，不是代码。

6. **进程内假服务器（`coworker/testing/fake_slack/`）** —— Starlette 起一个真的假 Slack，让真实 adapter 端到端跑，不碰网络不要 token。MediaBot 靠注入 `CliRunner` 已经够用，但 Telegram Bot API 这类 HTTP 通道用假服务器测更接近真实。中等价值。

### 8.2 MediaBot 反而领先的两处（别为了统一而退化）

- **审批快照 + 执行前哈希校验**：OpenWorker 的审批是一次 turn 内的内存对象，没有"批准后内容被改"的检测（`hashlib` 只用在 PKCE、PDF 缓存、session id 哈希上）。MediaBot 的 `payload_hash` 更强。
- **幂等键**：OpenWorker 没有等价物。它的动作重放代价低（重发一条 Slack）；MediaBot 重放一条小红书不可撤回。

### 8.3 一句话判断

**它的风险分级和目标绑定授权比我们细，我们的执行前完整性和幂等比它硬。** 借它的授权粒度，别动我们的执行保证。
