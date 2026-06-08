# Stated

**Shared state layer for AI coding agents.** _Git for AI work._

Let Claude Code, Codex, Cursor and OpenHands collaborate without losing context.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)

---

## The problem

AI coding agents waste tokens reconstructing context, over and over:

- A new chat loses everything.
- Claude Code doesn't know what Codex did.
- Codex doesn't know what Cursor changed.
- Multiple agents duplicate work and edit the same files.
- Project decisions get lost.
- Handoffs are terrible.

Developers patch this by hand with `README.md`, `CLAUDE.md`, `TODO.md`, memory
prompts and handoff prompts. It doesn't scale.

## The solution

Stated creates a **shared project brain** that lives _inside the repository_:

```text
project/
└── .stated/
```

- **No cloud. No accounts. No telemetry. No AI models. No vector databases.
  No embeddings. No external services. No SaaS.**
- The repository is the source of truth — not a database, not a memory store.
- Everything is human-readable, AI-readable, Git-friendly and merge-friendly.

Any agent can instantly answer — without reading thousands of tokens:

```text
What are we building?
What is the current task?
What decisions were made?
Who is working on what?
What should I do next?
```

---

## Install

```bash
npm install -g stated
```

## 30-second quickstart

```bash
cd your-project
stated init
```

In **Claude Code**:

```text
Build OAuth
```

…which (via the MCP server) creates tasks, claims files and records decisions.

Open **Codex** later:

```text
Continue project
```

It instantly sees the current goal, current tasks, decisions, ownership and the
recommended next steps — because they all live in `.stated/`.

---

## How it works

```text
   Claude Code ─┐
        Codex ──┤
       Cursor ──┼──►  .stated/  (shared project state, committed to Git)
    OpenHands ──┤
       Humans ──┘
```

Stated is three things over one on-disk format:

1. A **CLI** (`stated …`) for humans and shell scripts.
2. An **SDK** (`import { Stated } from "stated"`) for programmatic use.
3. An **MCP server** so any MCP-compatible agent reads/writes the same brain.

### Repository structure

```text
.stated/
├── project.md      # name, description, architecture, status (human-authored)
├── goals.md        # ## Active / ## Completed bullet lists
├── tasks.json      # the task board (canonical)
├── decisions.md    # rendered decision log (from the event stream)
├── agents.json     # registered agents + heartbeats
├── files.json      # file ownership / soft locks
├── handoff.md      # ⭐ generated handoff — the most important file
├── state.json      # compact machine state for fast agent loading
├── events.jsonl    # append-only event history
└── snapshots/      # timestamped restore points
```

`handoff.md` and `state.json` are **derived** — Stated regenerates them
automatically after every task creation, task completion, decision, file claim
or goal change. You never edit them by hand.

---

## CLI

```text
stated init                       Create .stated/ in the current directory
stated status                     Show the current shared project state
stated state                      Print machine-readable state.json
stated handoff                    Generate & print handoff.md

stated goal add <text>            Add an active goal
stated goal complete <query>      Mark a matching active goal completed
stated goal list                  List goals

stated task add <title>           Create a task (--priority, --description)
stated task list                  List tasks
stated task claim <id>            Claim a task (--agent <name>)
stated task start <id>            Mark a task active
stated task complete <id>         Mark a task completed
stated task block <id>            Mark a task blocked (--reason <text>)

stated decision add <text>        Record a decision (--reason, --by)

stated agent register <name>      Register / heartbeat an agent
stated agent list                 List agents

stated file claim <path>          Claim/lock a file (--agent <name>)
stated file release <path>        Release a file
stated file list                  List file ownership

stated snapshot                   Write a restore point to .stated/snapshots/
stated doctor                     Validate .stated/ integrity
stated mcp                        Start the MCP server (stdio)
```

Global flags: `--agent <name>` (or `STATED_AGENT` env), `--json`, `--force`,
`--version`, `--help`.

### Example session

```bash
stated init
stated agent register "Claude Code"
stated goal add "Launch MailMeld"
stated task add "Build OAuth" --priority high
# → ✔ Task created: Build OAuth t_14cd6af8
stated task claim t_14cd6af8 --agent "Claude Code"
stated decision add "Use BullMQ" --reason "Reliable retries"
stated file claim src/auth.ts --agent "Claude Code"
stated handoff
```

---

## SDK

```ts
import { Stated } from "stated";

// `agent` attributes every mutation and refreshes the agent's heartbeat.
const stated = new Stated({ agent: "Claude Code" });

await stated.init();                 // create .stated/ if missing
await stated.registerAgent();        // announce yourself

await stated.addGoal("Launch MailMeld");
const task = await stated.addTask({ title: "Build OAuth", priority: "high" });
await stated.claimTask(task.id);     // owner defaults to the configured agent

await stated.addDecision({ decision: "Use BullMQ", reason: "Reliable retries" });
await stated.claimFile("src/auth.ts");

const state = await stated.getState();       // compact machine state
const handoff = await stated.getHandoff();   // full handoff document

await stated.completeTask(task.id);
await stated.releaseFile("src/auth.ts");
```

Need the low-level synchronous functions? They are exported too:

```ts
import { buildState, addTask, claimFile } from "stated";
```

---

## MCP server

Stated ships an MCP server so Claude Code, Codex, Cursor, OpenHands and any other
MCP-compatible client can share the same project brain.

**Tools:** `init_project`, `register_agent`, `get_state`, `get_handoff`,
`generate_handoff`, `create_task`, `claim_task`, `start_task`, `complete_task`,
`create_decision`, `claim_file`, `release_file`, `create_snapshot`.

**Resources (read-only):** `stated://handoff`, `stated://state`,
`stated://tasks`, `stated://agents`.

### Claude Code

```bash
claude mcp add stated -- stated mcp
```

### Cursor / Windsurf / generic clients

Add to your MCP config (`.cursor/mcp.json`, `mcp.json`, etc.):

```json
{
  "mcpServers": {
    "stated": {
      "command": "stated",
      "args": ["mcp"]
    }
  }
}
```

The server operates on the project at `STATED_ROOT` (env) or the directory it is
launched from. Set `STATED_ROOT` when your client launches the server from a
different working directory:

```json
{
  "mcpServers": {
    "stated": {
      "command": "stated",
      "args": ["mcp"],
      "env": { "STATED_ROOT": "/abs/path/to/project" }
    }
  }
}
```

You can also run the dedicated binary directly: `stated-mcp`.

### Recommended agent workflow

1. `register_agent` once at the start of a session.
2. `get_handoff` (or read `stated://handoff`) to load context in one shot.
3. `claim_task` / `claim_file` before working so others don't duplicate effort.
4. `create_decision` for any durable choice.
5. `complete_task` / `release_file` when done.

---

## Design principles

- **The repo is the source of truth.** State is committed to Git like code.
- **Human- and AI-readable.** Markdown for humans, JSON for machines, both diffable.
- **Merge-friendly.** Pretty-printed JSON with stable key order and trailing
  newlines; an append-only `events.jsonl` instead of in-place rewrites for history.
- **Crash-safe writes.** Every write is atomic (temp file + `fsync` + rename), so
  a killed or concurrent process never leaves a half-written state file.
- **Zero magic.** No models, no embeddings, no network. Just files and heuristics.

## Performance

Measured warm on a laptop SSD (`buildState`/handoff are pure derivation; mutations
are durably `fsync`-flushed and auto-regenerate the snapshot):

| Operation             | Target   | Typical |
| --------------------- | -------- | ------- |
| `stated init`         | < 100 ms | ~16 ms  |
| State load (`getState`) | < 5 ms | ~0.3 ms |
| Handoff generation    | < 50 ms  | ~15 ms  |
| Task claim (durable, auto-snapshot) | < 5 ms* | ~19 ms |

\* The in-memory claim itself is sub-millisecond; the durable write path
(`fsync` + automatic `handoff.md` / `state.json` regeneration) dominates. Set
this aside only if you understand the durability trade-off.

## Framework detection

On `init` Stated detects your stack (no network) and stores it in `state.json`:
Next.js, React, Vue, Angular, Express, Fastify, Laravel, Django, Flask.

---

## Development

```bash
npm install
npm run build       # compile TypeScript to dist/
npm test            # run the vitest suite
npm run typecheck   # type-check without emitting
```

The codebase is layered:

```text
src/core/   canonical synchronous file API (one module per .stated file)
src/sdk/    ergonomic async Stated class
src/cli/    dependency-free argument parser + command handlers
src/mcp/    MCP server (tools + resources) over the core API
```

## License

MIT — see [LICENSE](LICENSE).
