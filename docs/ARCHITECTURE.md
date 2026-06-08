# Architecture

Cairn is layered so that every higher layer is a pure projection of the one below.
The only stateful, authoritative layer is the event store.

```text
  CLI / SDK / MCP                 (surfaces — thin)
        │
  Engines: state · context · timeline · memory · snapshots · observability · git
        │                         (pure derivation + ops)
  Reducers                        (pure folds: event → state)
        │
  EventStore (SQLite WAL)         (append-only source of truth)
        │
  .agent/journal.db
```

## Modules

| Path | Responsibility |
|---|---|
| `core/types.ts` | Protocol types: events, derived domain entities, manifest |
| `core/ids.ts` | Monotonic ULIDs, short ids, time helpers |
| `core/paths.ts` | `.agent/` layout, root discovery |
| `core/schema.ts` | SQLite DDL + versioned migrations |
| `core/store.ts` | `EventStore`: append/batch/query/stream/replay/compact/export |
| `core/manifest.ts` | `init` + manifest read/write |
| `reducers/index.ts` | Pure folds for goals/tasks/decisions/agents/files/knowledge |
| `engines/state.ts` | `deriveState` (snapshot+tail fast path), selectors |
| `engines/snapshots.ts` | Snapshot create/lookup + auto policy |
| `engines/context.ts` | The context compiler (small/medium/large/full) |
| `engines/timeline.ts` | Human-readable day-grouped timeline |
| `engines/memory.ts` | `deriveMemory/Knowledge/Timeline/Context` |
| `engines/observability.ts` | health, integrity validation, repair |
| `engines/git.ts` | Repo/branch/commit correlation (reads `.git` directly) |
| `sdk/index.ts` | `AgentJournal` — ergonomic façade, auto-snapshot, emitters |
| `cli/index.ts` | `cairn` command-line |
| `mcp/server.ts` | MCP tools + resources |

## Data flow

1. An agent appends an event (`appendEvent` / `cairn append` / `append_event`
   MCP tool). The store assigns `seq`, enforces `id` idempotency, commits.
2. After an append, the SDK checks the snapshot policy and, if due, materializes
   a snapshot.
3. A read (`getState` / `query_context` / `cairn timeline`) loads the latest
   snapshot, replays the tail, and projects the requested view. No writes.

## Why SQLite + a filesystem layout

- **SQLite** gives transactions, WAL concurrency, indexed queries, and scales to
  10M+ rows — the things a JSON file cannot.
- **The `.agent/` layout** gives portability and a place for artifacts, schemas,
  and an optional JSONL export mirror, so the protocol isn't *only* a binary db.

## Determinism boundary

Everything from reducers up is pure. The only places that touch wall-clock time
are: `timestamp`/`generatedAt` stamping and agent-liveness/snapshot-policy
checks — all of which accept an injectable `now` for deterministic tests.

## Failure model

- Corrupt payload on one row → isolated (`_corrupt` marker), surfaced by
  `validateIntegrity`, never crashes a fold.
- Lost snapshots/caches → zero data loss; re-derive from events.
- Schema drift → `cairn migrate` brings an old journal forward.
