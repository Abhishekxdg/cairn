# Contributing to AJP

Thanks for helping build the open standard for AI agent memory.

## Setup

```bash
cd ajp
npm install
npm run build
npm test
```

`better-sqlite3` is a native module; `npm install` uses prebuilt binaries where
available (no toolchain needed on common platforms).

## Layout

```text
src/core/     event store, schema/migrations, types, ids, paths, manifest
src/reducers/ pure folds (event → state)
src/engines/  state, snapshots, context, timeline, memory, observability, git
src/sdk/      AgentJournal façade
src/cli/      ajp CLI
src/mcp/      MCP server
test/         store, reducers, state, engines, migration, concurrency, perf, sdk, mcp
docs/         protocol + subsystem docs
```

## Invariants to preserve

1. **Events are immutable.** Never add an API that edits or deletes an event.
   State changes are new events only.
2. **Reducers are pure.** No I/O, no clock reads, no random ids. Derived-entity
   ids come from the payload or the event id (determinism — see
   [PROTOCOL.md](docs/PROTOCOL.md) § 5).
3. **The journal is the only source of truth.** Anything else is a derivable
   cache; losing it must cost zero data.
4. **Concurrency safety is non-negotiable.** No read-modify-write on shared
   state. New writes go through `EventStore` (single-row append or a transaction).
5. **Don't break old journals.** Schema changes are additive forward migrations
   ([MIGRATIONS.md](docs/MIGRATIONS.md)).

## Adding an event type

1. Add it to `KnownEventType` in `core/types.ts` and document it in
   [EVENT_MODEL.md](docs/EVENT_MODEL.md).
2. Handle it in `reducers/index.ts` (or intentionally leave it
   history-only).
3. If it affects timelines, add a case in `engines/timeline.ts`.
4. Add a reducer test in `test/reducers.test.ts`.

## Before a PR

```bash
npm run typecheck
npm test
```

Keep the docs in sync with behavior. By contributing you agree to license your
work under the MIT License.
