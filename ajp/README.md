# Agent Journal Protocol (AJP)

**The Git of AI memory.** Local-first cognition infrastructure for AI agents.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)

A universal, event-sourced memory protocol for AI agents. Everything an agent
learns, decides, creates, modifies, observes and completes becomes an immutable
event in an append-only journal. **Memory, state, tasks, handoffs, context,
coordination and knowledge are all *derived* from that journal** — never stored
separately, never the source of truth.

```text
History is truth.   State is a cache.   Snapshots are an optimization.   Events are forever.
```

This is **not** a vector database, a RAG product, a memory framework, a task
manager, or an agent framework. It is the foundational layer those things should
be built *on top of*.

---

## Why

Every agent today reconstructs context from scratch, can't see what another
agent did, and loses decisions across sessions. The fix isn't a smarter cache —
it's a shared, durable, append-only record of cognition that any tool can read
and write. The `.agent/` directory is to AI memory what `.git` is to source.

- **Local-first.** No cloud, no accounts, no telemetry, no proprietary storage.
- **Concurrency-safe.** SQLite + WAL: many agents (Claude Code, Codex, Cursor,
  OpenHands) append simultaneously with no lost updates, no corruption.
- **Model/framework/language agnostic.** The journal is just events.
- **Derivable.** Lose every cache and snapshot and you lose nothing — state
  rebuilds from history.

## Install — once, globally (recommended)

Install it one time on your machine; your agents set up every project for you
after that — you never run per-project install again.

```bash
npm install -g agent-journal-protocol
```

The global `postinstall` writes a tiny **bootstrap rule** into your *global*
agent files (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, a generic
`~/.config/ajp/AGENTS.md`, plus `~/.gemini/GEMINI.md` if present). That rule
tells every agent:

> "When you start in a repo that has no `.agent/`, run `ajp setup` first."

So from now on, the **agent** creates the journal and wires the project on its
first visit — automatically. Your own content in those global files is kept (the
rule lives in a managed `<!-- AJP-GLOBAL:… -->` block). Undo anytime with
`ajp uninstall-global`; re-run with `ajp install-global`.

### Or: per-project install (no global)

```bash
cd your-project
npm install --save-dev agent-journal-protocol
```

A `postinstall` step then automatically:

1. **Creates the `.agent/` journal** in your project.
2. **Teaches every coding agent how to use it** — it writes the AJP usage rules
   into the instruction files agents already read on their own
   (`AGENTS.md`, `CLAUDE.md`, and any existing `GEMINI.md` / `.cursorrules` /
   `.github/copilot-instructions.md`). Your own content in those files is kept;
   the AJP rules go in a managed block between markers.

No MCP, no manual wiring. The next time Claude Code, Codex, Cursor, Copilot or
Gemini opens the repo, it reads those rules and starts recording to the journal
with the `ajp` CLI.

Re-run anytime with `ajp setup` (add `--all` to also create the secondary agent
files). Opt out of the auto-step with `AJP_NO_POSTINSTALL=1`. Prefer it global?
`npm install -g agent-journal-protocol`, then `ajp setup` per project.

### How your agents use it (the rules they're taught)

Agents are instructed to: **read before they write** (`ajp context` at session
start), then **record each real action as one event** — task created/started/
completed, decision made (with a reason), knowledge learned, file modified — and
to **never edit `.agent/` by hand** (it's append-only; history is truth). The
full ruleset lives in [docs/AGENT_RULES.md](docs/AGENT_RULES.md) and is what gets
injected into the agent files.

## Quickstart (manual, if you skipped the package)

```bash
cd your-project
ajp init          # journal + teach agents (same as the auto-setup)

ajp append --type agent.registered --payload '{"name":"Claude Code"}' --actor "Claude Code"
ajp append --type goal.created      --payload '{"id":"g1","title":"Launch MailMeld"}'
ajp append --type task.created      --payload '{"id":"t1","title":"Build OAuth","priority":"high"}'
ajp append --type task.started      --payload '{"id":"t1"}'
ajp append --type decision.made     --payload '{"id":"d1","title":"Use SQLite","rationale":"WAL concurrency"}'

ajp status
ajp context --level small     # minimum-token context for an agent
ajp timeline                  # human-readable "what happened"
ajp doctor                    # health + integrity
```

## Architecture (one screen)

```text
                 append events
   agents  ─────────────────────►  .agent/journal.db  (SQLite, WAL, append-only)
                                          │
                                          │  pure, deterministic reducers
                                          ▼
                                    DerivedState
                                          │
        ┌──────────────┬─────────────┬────┴────────┬──────────────┐
        ▼              ▼             ▼             ▼              ▼
     state         context       timeline       memory        snapshots
   (cache)       (compiler)    (what happened) (knowledge)  (optimization)
```

```text
.agent/
├── manifest.json     # protocol version, projectId, name
├── journal.db        # SQLite (WAL) — the source of truth
├── snapshots/        # materialized state caches (rebuildable)
├── artifacts/        # large outputs referenced by events
├── state/            # derived state exports (git-ignored)
├── schemas/          # event payload schemas
├── indexes/ locks/   # derived/optimization (git-ignored)
└── events/           # optional JSONL export mirror (portability)
```

Derived/optimization files are **git-ignored** by default — the journal is the
only thing worth committing, and it never produces merge-conflict-heavy
generated artifacts. See [ARCHITECTURE.md](docs/ARCHITECTURE.md).

## The event model

Every event is immutable and shaped the same way:

```jsonc
{ "id": "01KT…", "seq": 42, "timestamp": "…", "actor": "Claude Code",
  "sessionId": "…", "projectId": "…", "type": "decision.made",
  "version": 1, "payload": { "title": "Use SQLite", "rationale": "WAL" } }
```

`seq` is a gap-free total order; `id` is a time-sortable ULID used for
idempotency. Canonical types cover agents, goals, tasks, decisions, files,
artifacts, knowledge, memory, messages, sessions and snapshots — plus open
`custom.*` extensions. Full catalogue in [EVENT_MODEL.md](docs/EVENT_MODEL.md).

Decisions and tasks have real lifecycles derived from events — e.g. a new
`decision.made` with `supersedes` flips the prior decision to `superseded`, so
consumers see exactly one active decision. See [PROTOCOL.md](docs/PROTOCOL.md).

## SDK

```ts
import { AgentJournal } from "agent-journal-protocol";

const journal = new AgentJournal({ actor: "Claude Code" });
journal.registerAgent();

const { id } = journal.createTask({ title: "Build OAuth", priority: "high" });
journal.startTask(id);
journal.decide({ title: "Use SQLite", rationale: "WAL concurrency" });

const ctx = journal.getContext("small");   // compiled, minimum-token
const state = journal.getState();           // full derived state
const timeline = journal.renderTimeline();  // human-readable
journal.completeTask(id);
```

Low-level building blocks (`EventStore`, reducers, engines) are exported too.
See [SDK.md](docs/SDK.md).

## MCP server

```bash
claude mcp add ajp -- ajp mcp
```

Tools: `append_event`, `query_state`, `query_context`, `query_memory`,
`query_timeline`, `register_agent`, `create_snapshot`, `get_active_tasks`,
`get_active_decisions`. Resources: `ajp://state`, `ajp://context`.
See [MCP.md](docs/MCP.md).

## CLI

```text
ajp init | status | append | state | timeline | context | snapshot
        | compact | prune | export | doctor | migrate | repair | mcp
```

- `ajp compact [--keep-recent N]` — cold-archive old events behind a snapshot so
  the hot table stays fast at scale (events are moved, never lost).
- `ajp prune [--idle-ms N]` — disconnect stale agents (records `agent.disconnected`).

## Performance

| Operation            | Target    | Measured |
| -------------------- | --------- | -------- |
| Append event         | < 5 ms    | sub-ms (batched ~0.01 ms/event) |
| State derive         | < 5 ms\*  | snapshot+tail, ms-scale on realistic boards |
| Context generation   | < 50 ms   | ✓ (asserted at 10–20k events) |
| Timeline generation  | < 50 ms   | ✓ |
| Cold start           | < 200 ms  | ✓ on realistic journals |
| Scale                | 10M+ events | paged streaming + cold-archive compaction |

\* via snapshot + tail replay; full cold replay scales linearly and is the
fallback. The numbers above are enforced by `test/perf.test.ts` at 10–20k events
(realistic project size). At pathological scale (e.g. 200k *simultaneously
active* tasks) materializing the full board costs more — run `npm run bench`
(default 10M; pass a count) for stress numbers on your hardware. Memory stays
flat under streaming regardless of journal size (`test/perf.test.ts` asserts a
bounded heap delta over a 50k-event stream). See
[CONCURRENCY.md](docs/CONCURRENCY.md) for the safety model.

## Documentation

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — components and data flow
- [PROTOCOL.md](docs/PROTOCOL.md) — the protocol specification
- [EVENT_MODEL.md](docs/EVENT_MODEL.md) — event types and payloads
- [CONCURRENCY.md](docs/CONCURRENCY.md) — the no-lost-updates guarantee
- [MCP.md](docs/MCP.md) · [SDK.md](docs/SDK.md) · [MIGRATIONS.md](docs/MIGRATIONS.md)
- [ROADMAP.md](docs/ROADMAP.md) · [CONTRIBUTING.md](CONTRIBUTING.md)

## License

MIT — see [LICENSE](LICENSE).
