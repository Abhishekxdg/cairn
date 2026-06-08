# Roadmap

Cairn aims to be the standard memory layer for AI agents. The v0.1
implementation is a complete vertical slice; the items below deepen it.

## v0.1 — reference implementation (shipped)

- Append-only SQLite/WAL event store: append, batch, query, stream, replay,
  compact, export; ULID idempotency; gap-free `seq`.
- Pure reducers + derived state (goals, tasks, decisions, agents, ownership,
  knowledge) with task & decision lifecycles.
- Snapshot engine (auto every 100 events / 5 min; snapshot+tail derivation).
- Context compiler (small/medium/large/full), timeline engine, memory layer.
- **Git auto-capture** (`cairn sync` + post-commit hook): file events derived
  deterministically from commits, attributed to authors — accurate journal with
  zero agent effort. Agents record only intent (goals/decisions/knowledge/tasks).
- Cold-archive compaction (`events_archive`): move pre-snapshot events out of the
  hot table — events stay in the journal, derivation/export/replay unaffected.
- Automatic agent pruning + stale detection (`cairn prune`).
- Migrations, observability (health/integrity/repair), git correlation.
- CLI, TypeScript SDK, MCP server.
- Tests (90%+ coverage of logic): store, reducers, state, engines, compaction,
  migration, concurrency (multi-process), crash recovery, performance (incl.
  flat-memory streaming + cold start), git, SDK, CLI, MCP. `npm run bench` for
  10M-scale numbers.

## v0.2 — hardening & ergonomics

- Richer query API: full-text over payloads, per-entity history (`task t1`),
  `as-of` time-travel CLI.
- Event payload schema registry under `.agent/schemas/` with validation on
  append (opt-in, zod-backed).
- Context compiler token budgeting by actual token count, not item counts.

## v0.3 — interop & standardization

- **Python, Go, Rust SDKs** reading/writing the same `.agent/journal.db`.
- A conformance test suite implementations can run against the JSON export.
- Formalize the protocol spec (RFC-style) for internal review.

## v0.4 — ecosystem

- Adapters that *derive* existing formats from the journal: `CLAUDE.md`,
  `TODO.md`, handoff docs, knowledge-graph exports — strictly one-way (journal →
  format), never the reverse.
- Optional networked/remote-sync backend (libsql/Turso) for multi-machine teams,
  preserving local-first as the default.
- Editor/agent integrations: auto-emit `file.modified` / `decision.made` from
  hooks.

## Non-goals (permanent)

- Becoming a vector DB, RAG product, memory framework, task manager, or agent
  framework. Cairn is the substrate those build on.
- Cloud-by-default, accounts, telemetry, or proprietary storage.
- Embeddings/model inference inside the protocol.
