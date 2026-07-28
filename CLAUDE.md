# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

MediaBot is an open-source (Apache-2.0) media-operations agent for individuals, communities, and
small companies without a dedicated social-media-ops role. It runs on top of Claude Code (or any
compatible CLI reachable via `ANTHROPIC_BASE_URL`, e.g. Kimi/GLM/DeepSeek proxies) rather than
inventing a new agent runtime.

TypeScript, CommonJS, run through `tsx` — there is no build step. Node ≥ 20, **pnpm**.

## Commands

```bash
pnpm install
pnpm typecheck                       # tsc --noEmit; strict + noUncheckedIndexedAccess
pnpm test                            # tsx --test "src/**/*.test.ts"
pnpm test:conformance                # provider contract conformance suite
pnpm daemon                          # long-running process + console on 127.0.0.1:7788
pnpm drill                           # end-to-end acceptance drill, all dry-run, safe to re-run
pnpm cli <command>                   # see `pnpm cli help`

# one test file / one test
pnpm exec tsx --test src/core/approval.test.ts
pnpm exec tsx --test --test-name-pattern "refuses" src/core/approval.test.ts

# conformance for a third-party provider
pnpm test:conformance --provider ./my-provider.ts --slot publisher
```

CI (`.github/workflows/ci.yml`) runs exactly typecheck → test → test:conformance. Conformance is a
first-class gate, not an extra: providers are pluggable, so contract drift must fail in CI rather
than surface when someone's provider misbehaves in production.

Tests use `node:test` + `node:assert` and never touch the network, a real browser, or a real
platform — subprocess runners (`CliRunner`), the Claude runner, the Playwright launcher and the
clock are all injectable. Keep it that way; a test that needs credentials is a test nobody runs.

## The five-pillar loop

Every media-ops workflow (personal, community, or commercial) reduces to five steps, and MediaBot's
architecture is organized around them:

1. **目标 Goal** — what outcome is wanted, verified against a measured baseline (`core/goals.ts`,
   `core/metrics.ts`)
2. **内容 Content** — draft generation from source material (`providers/composer/*`)
3. **发布 Publish** — multi-platform distribution, Chinese platforms (XiaoHongShu/公众号/视频号/抖音)
   included — this is the biggest gap in the existing OSS landscape (see `docs/research.md` §4)
4. **反馈 Feedback** — replying to comments/DMs on your own posts (`core/engagement.ts`, inbound),
   distinct from proactively commenting on others' posts (`core/outreach.ts`, outbound)
5. **监控 Monitoring** — read-only tracking that feeds back into step 2; "eyes, not hands" —
   monitoring agents never publish directly

## Architecture

MediaBot is **an orchestration layer plus capability contracts, not the capabilities themselves.**
Four pluggable slots, defined as pure types in `src/contracts/` (this is the plugin ABI — a
breaking change there breaks every external provider, and those files must contain no
implementation):

```
SourceProvider     read-only input    trends / news / competitors / comments
ComposerProvider   production         text / image / audio / video
PublisherProvider  output             per-platform publishing      ← approval-gated
EngagementProvider loop-back          comments and replies         ← approval-gated
```

External capabilities are integrated by "least work wins": **① an MCP server = zero code, config
only** → **② a CLI wrapped in a subprocess (~50 lines)** → **③ native implementation only when
there is no other path**. Route ② also matters legally — invoking a binary is not a derivative
work, so it stays licence-clean even where the upstream source could not be copied.

Runtime layout:

- `src/daemon.ts` — owns time. Cron jobs (`ingest`, `publish`, `monitor`, `briefing`, `engage`,
  `outreach`, `goals`), the loopback HTTP console, and graceful shutdown. Claude Code is an
  interactive session and cannot hold a schedule open; the daemon spawns `claude --print` only for
  steps that need judgement.
- `src/core/pipeline.ts` — `ingest → compose → validate → propose → executeDue`. Owns persistence
  and the approval boundary; providers never see the database.
- `src/core/approval.ts` — the gate (see invariants below).
- `src/core/db.ts` — SQLite via better-sqlite3, WAL, `foreign_keys = ON`. Migrations are an
  ordered append-only list keyed by `user_version`; **never edit a shipped migration, add a new
  one.** Schema is documented in `docs/spec.md` §2.
- `src/cli.ts` — `mediabot` commands; also exports `buildProviders()` / `buildEngagement()`, which
  the daemon reuses so both entry points wire providers identically.
- `src/server/` — loopback-only HTTP API + server-rendered console.
- `src/core/cli-adapter.ts` — every subprocess call funnels through here so timeouts and error
  classification (`auth_expired` / `rate_limited` / `transient` / `rejected`) are uniform.
- `src/testing/conformance.ts` — behavioural checks: declared `limits` match real behaviour, ids
  are stable/idempotent, and read-only providers expose no write methods.

## Invariants — do not weaken these without an explicit decision

These are the reasons the system is safe to point at a real person's accounts. They are enforced by
code and by tests that assert the absence of capabilities.

1. **Every outbound action passes `ApprovalQueue`.** Publishing and replying both enqueue; nothing
   else may call a provider's `publish`/`reply`. There is no global "disable approval" switch. The
   MCP client (`core/mcp.ts`) is currently reachable only from the **source** slot
   (`providers/source/mcp.ts`) — keep it that way, or an MCP server gains a side channel around
   the gate.
   The one relaxation is a **standing rule** (`core/consequence.ts`): a human may pre-approve an
   exact `(action, target)` pair. It still creates a full approval row that goes pending →
   approved with the rule named in `decided_by`, and it is refused outright for anything
   classified `irreversible` — including a rule inserted into the database by hand, because the
   check is at read time, not only at grant time. A provider that declares no `consequence` is
   treated as irreversible.
2. **Approved payloads are hash-verified immediately before execution.** If the payload changed
   after approval, execution is refused and the item returns to `pending` (`ApprovalIntegrityError`).
3. **Publishing is idempotent** via a UNIQUE `idempotency_key` on `posts`, derived only from
   `(accountId, draftVariantId, scheduledFor)` — never from a call-time timestamp, which would
   differ across replays.
4. **Sources never write.** SourceProviders may only feed the queue or the briefing.
5. **Unverified browser selector profiles refuse to publish.** Selectors are configuration, not
   code; `verified: true` is set by a human who watched it work. Selectors copied from a
   third-party repo do not qualify — "looks right" is not "watched it run".
6. **The console binds 127.0.0.1 and rejects non-loopback callers** even so. The database holds
   platform credentials and pending outbound posts.
7. **No vote manipulation, no multi-persona.** Reddit is one openly-attributed account; upvoting is
   deliberately not implemented and a test asserts it stays that way. Outreach (commenting on
   strangers' posts) is off by default, has DB-enforced daily caps and randomised gaps, and the
   model is instructed to answer SKIP rather than write filler. Rationale: `docs/acceptance.md` §3.
8. **Secrets are never stored in `config.json`.** Values are `secret:<name>` references resolved
   through `CredentialStore` (macOS Keychain, else AES-256-GCM file at 0600). Anything written to
   `runs` goes through `core/audit.ts` first — that table is meant to be readable by a human, so
   it must never accumulate credentials.
9. **公众号 creates drafts only** — the final send stays a human action in WeChat's console.
10. **Approving by reply is bound to one account id.** `core/approval-reply.ts` decides nothing
    unless the sender matches `notify.telegramOwnerId`; with no owner configured the feature is
    off entirely. Authorisation is by numeric id, never display name. A reply can only approve or
    reject — editing stays in the console, since a remote edit would re-hash a payload nobody
    re-read.
11. **One `getUpdates` consumer per bot token.** Polling with an offset acknowledges those
    updates, so two consumers steal each other's messages permanently. `wireReplyApproval()`
    (`providers/telegram/approval-poller.ts`) is the single place that decides: attach to the
    engagement provider if one exists, otherwise poll — never both.

## Working conventions

- Work is tracked in `docs/tasks.md` as `T<milestone>.<n>` with machine-verifiable acceptance
  criteria; commits use `feat(T8.5): …` / `docs(T8.7): …`. Update the task entry with what actually
  happened — including bugs found in the process — rather than just ticking the box.
- `docs/acceptance.md` is the user-defined "is it done" standard (五条验收标准); `docs/spec.md` is
  the data model and state machines; `docs/architecture.md` is the contracts and slots;
  `docs/research.md` is the 21-repo landscape survey and licence audit. Read `research.md` before
  proposing implementation choices — it documents *why* each decision was made.
- Comments explain the non-obvious reason a line exists (why a hash is recomputed, why a gap is
  randomised), not what the code does. Match that density.
- Content-facing strings and docs are Chinese; code, identifiers and code comments are English.

## License discipline

The project is Apache-2.0. Several reference repos in `docs/research.md` are AGPL-3.0
(gitroomhq/postiz-app, postiz-agent) or have no LICENSE file at all (social-auto-upload,
Smb-Marketing-Agent, and others) — for those, only architecture/interface ideas may be reused, and
code must be written fresh. Repos under MIT/Apache-2.0 may be studied and adapted directly. Check
`docs/research.md` §5 before porting any logic from a reference repo.

## Local reference clones

21 reference repos are cloned (not committed) under `research/refs/` for source-level
study. They are gitignored — each carries its own `.git`, so never `git add` that tree.

## Sibling project: Agent24 (@iDoris-ai/Agent24)

@github.com/iDoris-ai/Agent24 — local clone `~/Dev/auraai/Agent24`

Same author, deliberately the **other half** of the same problem:

|  | Agent24 | MediaBot |
|---|---|---|
| Position | **Builds the runtime** — owns the model layer | **Rides a runtime** — Claude Code login session |
| Model strategy | local/small-model first, tiered router, privacy-forced-local | borrow an existing frontier subscription |
| Shape | general-purpose 24/7 personal agent | one workload: media operations |

Both independently converged on approval gates, SQLite, daemon+scheduler, contract-first design,
and hand-rolling an MCP client — so where the two **diverge** is where each has something to learn.
Agent24 tracks the reverse direction under `docs/specs/TASKS.md` → "M-G 从 MediaBot 借鉴".

### What MediaBot can take from Agent24

1. **Privacy as a mechanism, not a config toggle.** "Can switch to Kimi/GLM/DeepSeek" is
   configuration; Agent24's `Privacy::LocalOnly` is enforced — a sensitive task with no local
   provider *errors* rather than silently falling back to a remote one. Unpublished drafts and
   monitoring intel are arguably sensitive.

2. **Hash-chained audit.** Approvals are hashed individually, but the `approvals`/`runs` tables are
   not chained. Agent24's audit table chains `prev_hash`, so "what was approved, and by whom" is
   tamper-evident. For a system publishing under a real person's name, that has legal weight
   beyond debugging.

3. **Cancellation propagation.** Agent24 threads a `CancellationToken` through every await —
   model calls, tool dispatch, MCP calls, even compaction. `runClaude` takes an `AbortSignal`, but
   the pipeline and scheduler do not thread one; Playwright-driven publishing is exactly the kind
   of thing that hangs, and a stuck publish currently blocks shutdown until the 5s force-exit.

(The MCP-bypass risk Agent24 warned about was checked: `McpClient` is only reachable from the
read-only source slot, so there is no path to `tools/call` around the approval gate. Invariant 1
above exists to keep it that way.)

### Known strategic risk (affects design, not just ops)

The README's "runs on your already-paid Claude Code login session" likely sits outside Anthropic's
terms for a third-party application, and MediaBot is meant to be distributed to others. Treat
login-session reuse as **one optional provider**, and keep the default path on a user-supplied API
key or a local model, so the product's real value (five-pillar loop + approval + multi-platform
publishing) is not bound to an interface we do not control.
