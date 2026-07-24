# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

MediaBot is an open-source (Apache-2.0) media-operations agent for individuals, communities, and
small companies without a dedicated social-media-ops role. It runs on top of Claude Code (or any
compatible CLI reachable via `ANTHROPIC_BASE_URL`, e.g. Kimi/GLM/DeepSeek proxies) rather than
inventing a new agent runtime.

**Status**: architecture/research phase. No implementation yet — see `docs/research.md` for the
full landscape survey (21 reference repos, license audit, architecture patterns) that this project
is designed from. Read it before proposing implementation choices; it documents *why* each design
decision was made and which upstream projects can be legally borrowed from vs. only studied.

## The five-pillar loop

Every media-ops workflow (personal, community, or commercial) reduces to five steps, and MediaBot's
architecture is organized around them:

1. **目标 Goal** — what outcome is wanted, verified against a measured baseline (pattern: NotFair's
   goal-negotiation loop)
2. **内容 Content** — draft generation from source material
3. **发布 Publish** — multi-platform distribution, Chinese platforms (XiaoHongShu/公众号/视频号/抖音)
   included — this is the biggest gap in the existing OSS landscape (see `docs/research.md` §4)
4. **反馈 Feedback** — replying to comments/DMs on your own posts (inbound), distinct from
   proactively commenting on others' posts to drive awareness (outbound)
5. **监控 Monitoring** — read-only tracking of news/trends/competitors that feeds back into step 2;
   "eyes, not hands" (pattern: unifapi-agent) — monitoring agents never publish directly

## License discipline

The project is Apache-2.0. Several reference repos in `docs/research.md` are AGPL-3.0
(gitroomhq/postiz-app, postiz-agent) or have no LICENSE file at all (social-auto-upload,
Smb-Marketing-Agent, and others) — for those, only architecture/interface ideas may be reused, and
code must be written fresh. Repos under MIT/Apache-2.0 may be studied and adapted directly. Check
`docs/research.md` §5 before porting any logic from a reference repo.

## Local reference clones

21 reference repos are cloned (not committed) under
`../Heinu1/research/media-boat-refs/` for source-level study — not part of this repo.
