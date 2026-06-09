# Cairn

**An append-only journal for AI agents. Git-like memory, without the complexity.**

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![npm](https://img.shields.io/badge/npm-%40memxai%2Fcairn-red.svg)](https://www.npmjs.com/package/@memxai/cairn)

Your AI coding agent starts every session blind. It re-reads the repo to work out
what's going on, can't see what another agent just did, and forgets every decision
the moment the session ends. You pay for that amnesia in tokens and in undone work.

Cairn fixes it with one idea borrowed from git: a small, shared, append-only
**journal** in your project's `.agent/` directory. Goals, decisions, tasks and
knowledge land there as they happen, and any agent reads the whole picture in a
single cheap step.

`.agent/` is to AI memory what `.git` is to source.

---

## Why it's useful

### 1. ~150× cheaper orientation — one read instead of a repo scan

Every session starts with the same expensive step: the agent re-discovers the
project — grepping, opening files, reconstructing "where were we." On a real
codebase that's **tens to hundreds of thousands of tokens, burned from zero, every
single session.**

Cairn keeps an always-current `CONTEXT.md` — goal, current task, active decisions,
recent activity, next steps — derived automatically from the journal. The agent
reads **that one ~1 KB file** instead of the repo.

```bash
cairn recall                  # the whole "where were we" in one cheap read
cairn context --level small   # token-budgeted context for a prompt
```

Orientation collapses from a repo scan to a single file read. That's the entire
pitch: Cairn is a memory layer that *saves* tokens, not one more thing to grep.

### 2. One memory for every agent — no lost work

Run Claude Code, Codex, Cursor and OpenHands on the same repo and each lives in its
own bubble: one refactors, another undoes it; a decision made in one session is
invisible to the next.

Cairn is the single journal they all read and write:

- **Concurrency-safe.** SQLite + WAL — many agents append at once, no lost updates,
  no corruption.
- **One source of truth for intent.** Record a decision once (`Use SQLite — WAL
  concurrency`) and every other agent and every future session sees it.
- **Supersede, don't contradict.** A decision that replaces an old one flips the
  old to `superseded` — everyone sees exactly *one* active answer.
- **Survives sessions.** Close the laptop, come back next week with a different
  agent — the context is still there.

### 3. Capture that costs nothing — it reads git, not your narration

Getting accurate data *in* is where memory systems die. Cairn doesn't ask agents to
hand-log their edits — it reads **git**. A post-commit hook turns every commit into
file events plus a commit record, attributed to the author, and even pulls decisions
out of commit messages. Log nothing and the journal still knows what changed, who
changed it, and when.

Agents record only the **intent git can't see** — goals, rationale, task lifecycle.
The rest is automatic.

### 4. Local-first — plain files, no lock-in

No accounts, no telemetry, no cloud. The source of truth is a line-based
`events.jsonl` committed with your repo, so it merges cleanly across branches. The
SQLite cache is git-ignored and rebuilt deterministically from it — delete every
cache and you lose nothing.

---

## Benchmarks — with vs without Cairn

It comes down to **orientation cost**: how many tokens an agent burns answering
*"where were we?"* before it does any real work. Measured on this repo with
`npm run wedge`:

### Orientation token cost

| Approach | What the agent reads | Tokens to orient |
|---|---|---|
| **Without Cairn** | git log + the 6 most-recently-changed source files (what a cold agent actually does) | **~15,600** |
| **With Cairn** | one `CONTEXT.md` read (~1 KB) | **~235** |
| **Difference** | | **~67× cheaper** |

> Reproduce: `npm run wedge` (or `node scripts/wedge-eval.mjs`) on this repo. The
> "without" figure depends on the size of the recently-changed source files, so the
> exact ratio moves with repo state — typically **50–100×** here. The direction is
> the constant: a fixed ~1 KB read versus a repo scan that only grows with the
> codebase.

That's per session, per agent. Four agents opening the repo 10×/day pay the
"without" cost **40 times a day** — roughly **620k tokens/day** on this repo —
versus ~9k with Cairn.

### It's not just cheaper — it's correct

The token ratio undersells it. `CONTEXT.md` carries facts a cold agent **cannot
reconstruct from code at any token cost**, because git shows *what* changed, never
*why it was decided*:

| Fact in `CONTEXT.md` | On this repo | Recoverable from a repo scan? |
|---|---|---|
| Current goal | "Ship Cairn v0.1" | Guessable, often wrong |
| Active decisions **+ rationale** | 9 | ❌ No — reasons aren't in the code |
| Recommended next action | 1 | ❌ No |
| Recent activity | 2 lines | Partially (git log) |

### Real-world A/B (third-party agent)

Same external agent (Codex), same repo, same prompt *"where were we?"*, the only
difference being journal access:

| | Without journal | With `CONTEXT.md` |
|---|---|---|
| Time to orient | 24 s | **17 s** |
| Outcome | Oriented to the **wrong project** (reconstructed stale work from the dirty tree), about to act on it | Oriented **correctly** — goal, the SQLite-WAL decision *with its reason*, the next step |
| Wrong/duplicate-work risk | High | None |

Without the journal a capable agent was *faster at being wrong*. That's the failure
Cairn removes.

---

## Setup guide

### 1. Install globally

```bash
npm install -g @memxai/cairn
```

The install is silent — it runs no setup and writes nothing to your repos. If your
npm global bin directory isn't on your `PATH`, the installer **adds it
automatically** (a marked block in `~/.zshrc` / `~/.bashrc`; opt out with
`CAIRN_NO_PATH=1`).

### 2. Activate `cairn` in your shell

```bash
source ~/.zshrc        # or just open a new terminal
cairn --version
```

### 3. Turn on the agent bootstrap (once per machine)

```bash
cairn install-global
```

This adds one rule to your agents' existing instruction files
(`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, …): *on its
first action in a repo that has no `.agent/`, the agent **asks you** whether to set
up Cairn. Only if you say yes does it run `cairn setup` and build the code graph
(`cairn index`).* No silent mutation, no MCP wiring. Your own content in those files
is preserved (Cairn lives in a managed block).

### 4. Set up a project

Let the agent prompt you on its next action — or do it yourself:

```bash
cd your-project
cairn setup            # creates .agent/ journal + code graph + git post-commit hook
```

### 5. Day to day

```bash
cairn recall                       # "where were we" — start every session with this
cairn status                       # goal, active tasks, decisions
cairn relevant "fix oauth refresh" # which files a task touches (no grep)
cairn timeline                     # what happened, by day
```

### Uninstall

```bash
cairn uninstall-global             # remove the agent rules from your dotfiles
npm uninstall -g @memxai/cairn     # remove the package + bins
# then delete the "# >>> cairn PATH >>>" block from ~/.zshrc
```

### Staying current

Updates don't install themselves, but Cairn makes them painless:

- **The binary** — any `cairn` command prints a one-line nudge when a newer
  version is on npm (checked at most once a day, cached, silent if you're current
  or offline). Update with `cairn upgrade` (or `npm i -g @memxai/cairn`). Opt out
  with `CAIRN_NO_UPDATE_CHECK=1`.
- **The agent rules** — self-healing. Each managed rule block is version-stamped;
  when you update the package, the next `cairn sync` (which the post-commit hook
  runs automatically) rewrites any out-of-date block in place. You never re-run
  setup just to get new rules.

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
cairn recall | status | context | relevant | append | timeline | sync
      | setup | install-global | uninstall-global | upgrade
      | snapshot | compact | prune | export | doctor | migrate | repair | mcp
```

---

## How it works

Agents **append events** to an append-only log. Everything else — state, context,
timeline, memory — is **derived** from that log by pure, deterministic reducers,
never stored separately. History is the truth; state is a cache; snapshots are an
optimization. That's why it stays correct under concurrency, and why a fresh clone
rebuilds perfectly from `events.jsonl` alone.

```text
agents ──append──► events.jsonl (source of truth) ──reducers──► state · context · timeline · memory
```

## License

[Apache License 2.0](LICENSE) — © 2026 memxai. Free to use, modify, and
distribute, with an explicit patent grant. Contributions are accepted under the
same license.
