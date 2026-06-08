# Cairn

**An append-only journal for AI agents. Git-like memory, without the complexity.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![npm](https://img.shields.io/badge/npm-%40memxai%2Fcairn-red.svg)](https://www.npmjs.com/package/@memxai/cairn)

Every coding agent starts each session blind. It re-reads your repo to figure out
what's going on, can't see what another agent already did, and forgets every
decision the moment the session ends. Cairn fixes that with one idea borrowed from
git: a small, shared, append-only **journal** in your project's `.agent/`
directory that records goals, decisions, tasks and knowledge as they happen — and
that any agent can read in a single cheap step.

`.agent/` is to AI memory what `.git` is to source.

---

## Why it's useful

### 1. Token savings — orient in one read, not a repo scan

The expensive part of every agent session is **orientation**: before it can do
anything, the agent burns tokens re-discovering the project — grepping, opening
files, reconstructing "where were we." On a real codebase that's easily
**hundreds of thousands of tokens, every session, repeated from zero.**

Cairn keeps an always-current `CONTEXT.md` — goal, current task, active decisions,
recent activity, next steps — derived automatically from the journal. The agent
reads **that one small file** (a few hundred tokens) instead of scanning the repo.

```bash
cairn recall          # the entire "where were we" in one cheap read
cairn context --level small   # token-budgeted context for a prompt
```

Orientation cost drops from a repo-scan to a single file read. That gap is the
whole point — Cairn is a **token-cheap memory layer**, not another thing to grep.

### 2. Multi-agent — shared memory, no lost work

Run Claude Code, Codex, Cursor and OpenHands on the same repo and today they each
live in their own bubble. One refactors, another undoes it; a decision made in one
session is invisible to the next.

Cairn is a **single shared journal** all of them read and write:

- **Concurrency-safe.** SQLite + WAL — many agents append at once, no lost
  updates, no corruption.
- **One source of truth for intent.** A decision recorded once (`Use SQLite —
  WAL concurrency`) is visible to every other agent and every future session.
- **Supersede, don't contradict.** A new decision that replaces an old one flips
  the old to `superseded`, so everyone sees exactly *one* active answer.
- **Survives sessions.** Close the laptop, come back next week, different agent —
  the context is still there.

### 3. Zero-effort capture — it reads git, not your narration

The hard part of any memory system is getting accurate data *in*. Cairn doesn't
ask agents to hand-log file edits — it reads **git**. A post-commit hook turns
every commit into file events + a commit record, attributed to the author, and
even extracts decisions from commit messages. So even if an agent logs nothing,
the journal still knows what changed, who changed it, and when.

Agents only record the **intent git can't see** — goals, rationale, task
lifecycle. Everything else is automatic.

### 4. Local-first — no cloud, no lock-in

No accounts, no telemetry, no proprietary storage. The source of truth is a
plain, line-based `events.jsonl` committed with your repo (merges cleanly across
branches). The SQLite cache is git-ignored and rebuilt deterministically from it —
lose every cache and you lose nothing.

---

## Install

One global install; your agents set up every project for you after that.

```bash
npm install -g @memxai/cairn
```

This teaches your agents (via their existing instruction files —
`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, etc.) one rule: *"when you open a repo
with no `.agent/`, run `cairn setup` first."* From then on, the agent creates the
journal and starts recording on its first visit — no MCP wiring, no per-project
install. Your own content in those files is preserved (Cairn lives in a managed
block).

Prefer per-project? `npm install --save-dev @memxai/cairn` does the same setup for
one repo.

---

## How agents use it

**Read before you write.** At session start, one cheap read:

```bash
cairn recall          # or: cairn context --level small
```

**Record intent as it happens** — one event per real action:

```bash
cairn append --type goal.created    --payload '{"id":"g1","title":"Ship v1"}'      --actor "Claude Code"
cairn append --type task.started    --payload '{"id":"t1"}'                          --actor "Claude Code"
cairn append --type decision.made   --payload '{"id":"d1","title":"Use SQLite","rationale":"WAL concurrency"}' --actor "Claude Code"
cairn append --type task.completed  --payload '{"id":"t1"}'                          --actor "Claude Code"
```

File changes are captured from git automatically — agents never log those.

### Find the right files without grepping blind

Cairn ranks which files a task likely touches by fusing git history (files that
change together) with a static code graph (imports + exported symbols) — so it
works even on a fresh repo with no history.

```bash
cairn relevant "add oauth refresh"        # ranked files, token-free, no embeddings
cairn context --task "add oauth refresh"  # project context + those files
```

---

## SDK

```ts
import { AgentJournal } from "@memxai/cairn";

const journal = new AgentJournal({ actor: "Claude Code" });
journal.registerAgent();

const { id } = journal.createTask({ title: "Build OAuth", priority: "high" });
journal.startTask(id);
journal.decide({ title: "Use SQLite", rationale: "WAL concurrency" });

const ctx = journal.getContext("small");   // compiled, minimum-token
journal.completeTask(id);
```

## MCP server

```bash
claude mcp add cairn -- cairn mcp
```

Tools: `append_event`, `query_state`, `query_context`, `query_memory`,
`query_timeline`, `register_agent`, and more. Resources: `cairn://state`,
`cairn://context`.

## CLI

```text
cairn recall | status | context | relevant | append | timeline
      | sync | snapshot | compact | prune | export | doctor | mcp
```

---

## How it works (one paragraph)

Agents **append events** to an append-only log. Everything else — current state,
context, timeline, memory — is **derived** from that log by pure, deterministic
reducers, never stored separately. History is the truth; state is just a cache;
snapshots are an optimization. That's why it's safe under concurrency and why a
fresh clone rebuilds perfectly from `events.jsonl`.

```text
agents ──append──► events.jsonl (source of truth) ──reducers──► state · context · timeline · memory
```

See [ARCHITECTURE.md](docs/ARCHITECTURE.md) · [PROTOCOL.md](docs/PROTOCOL.md) ·
[EVENT_MODEL.md](docs/EVENT_MODEL.md) · [CONCURRENCY.md](docs/CONCURRENCY.md) ·
[MCP.md](docs/MCP.md) · [SDK.md](docs/SDK.md) · [ROADMAP.md](docs/ROADMAP.md).

## License

MIT — see [LICENSE](LICENSE).
