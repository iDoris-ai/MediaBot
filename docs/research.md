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

克隆在本仓库 `research/refs/`（已加入 `.gitignore`，不随仓库提交，仅供本地查阅源码）。共 21 个仓库，约 586MB。
