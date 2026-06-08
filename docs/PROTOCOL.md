# Cairn — Specification (v1)

Status: draft · Schema version: 1

This document specifies the on-disk format, the event shape, and the derivation
rules that make Cairn a protocol rather than a library. Any implementation in any
language that obeys this spec can read and write the same `.agent/` journal.

## 1. Principles

1. **History is truth.** The append-only event log is the sole source of truth.
2. **State is a cache.** All state is a deterministic fold over events.
3. **Snapshots are an optimization.** They accelerate derivation and are always
   rebuildable from events.
4. **Events are immutable.** Never edited, never deleted, only appended.

## 2. Storage

- The journal lives in `.agent/journal.db`, a SQLite database in **WAL** mode.
- The filesystem layout (`.agent/…`) exists for portability and tooling; SQLite
  provides performance, transactions and concurrency.
- Derived artifacts (`state/`, `snapshots/`, `indexes/`, `locks/`, the WAL
  sidecar files) are **git-ignored**. Only the journal is canonical.

### 2.1 Tables

```sql
events(    seq INTEGER PK AUTOINCREMENT, id TEXT UNIQUE, timestamp TEXT,
           actor TEXT, session_id TEXT, project_id TEXT, type TEXT,
           version INTEGER, payload TEXT )         -- payload is JSON
snapshots( id TEXT PK, seq INTEGER, timestamp TEXT, state TEXT )  -- state is JSON
meta(      key TEXT PK, value TEXT )               -- schema_version, project_id, …
```

`seq` is the gap-free total order assigned by the engine. `id` is a ULID
(time-sortable) used for idempotency: re-appending an event whose `id` already
exists is a no-op.

## 3. Event shape

```jsonc
{
  "seq": 42,                       // assigned by the store (total order)
  "id": "01KTM3F26TQ307A8446BY20FJK", // ULID, unique, idempotency key
  "timestamp": "2026-06-08T17:11:12.346Z",
  "actor": "Claude Code",
  "sessionId": "sess_…",
  "projectId": "proj_…",
  "type": "decision.made",
  "version": 1,                    // payload schema version for this type
  "payload": { "title": "Use SQLite", "rationale": "WAL concurrency" }
}
```

`type` is either a canonical type (§ [EVENT_MODEL.md](EVENT_MODEL.md)) or any
namespaced extension string (`custom.*` by convention). Consumers MUST ignore
event types they do not understand rather than failing.

## 4. Idempotency & ordering

- Appends are single-row inserts; the engine assigns `seq` monotonically.
- Clients MAY supply an explicit `id` to make an append idempotent (safe retries,
  at-least-once delivery, multi-writer dedup).
- Total order is by `seq`. Wall-clock `timestamp` is informational and may be
  non-monotonic across actors/clocks; never derive ordering from it.

## 5. Determinism of derivation

Reducers MUST be pure: `reduce(state, event) → state` with no I/O and no clock
reads. Consequently:

- Derived-entity ids come from the event payload (`payload.id`) or, if absent,
  the event's own `id`. **Never** generate fresh ids inside a reducer — that
  would break replay determinism.
- Re-deriving from the same events always yields identical state (modulo the
  `generatedAt` stamp).

## 6. Lifecycles

### 6.1 Tasks

`todo → active → blocked → completed → archived`, driven by `task.created`,
`task.started`, `task.blocked`, `task.completed`, `task.archived`. Fields:
`owner`, `priority`, `dependencies`, `blockers`, `createdBy`, `completedBy`.

### 6.2 Decisions

`active → superseded | reverted | archived`. A `decision.made` whose payload
carries `supersedes: <id>` atomically marks the referenced decision
`superseded` and links `supersededBy`. **Consumers see only `active` decisions
by default.**

### 6.3 Agents

`agent.registered` / `agent.heartbeat` / `agent.disconnected`. Liveness
(`active | idle | offline`) is computed at read time from `lastSeen` against a
15-minute window; `disconnected` forces `offline`.

## 7. Snapshots

A snapshot is a materialized `DerivedState` pinned to a `seq`. To derive current
state, load the latest snapshot at or before the target `seq` and replay only
events after it. Auto-snapshot policy (reference implementation): every 100
events or 5 minutes. Snapshots are disposable.

## 8. Compaction

Events are forever — but they need not all live in the hot table. Compaction
moves events older than a covering snapshot from `events` into `events_archive`
(same database, same schema) and reclaims space (WAL checkpoint + VACUUM). This
is a **move, not a delete**: archived events remain part of the journal, are
included in `exportEvents()`, and are streamed (lowest `seq` first) during full
replay. `seq` is never reused, so the total order is preserved. An implementation
MUST require a snapshot covering the cut point before archiving, so that any
historical state remains reconstructable.

## 9. Versioning

`meta.schema_version` records the journal's format version. A newer binary
applies forward migrations in order (§ [MIGRATIONS.md](MIGRATIONS.md)) and never
breaks an older journal. Payload evolution is handled per-type via the event
`version` field.

## 10. Conformance

An implementation conforms if it: stores events per § 2–3; assigns gap-free
`seq`; enforces `id` idempotency; derives state with pure reducers per § 5–6;
and treats unknown event types as opaque. Cross-implementation interop is tested
against the JSON export (`cairn export`).
