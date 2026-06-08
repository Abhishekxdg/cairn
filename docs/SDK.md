# SDK

The TypeScript SDK is `AgentJournal`. One instance is one session: appends are
attributed to a configured `actor` + `sessionId`, auto-snapshot when due, and
every read is a projection over the journal.

## Install & import

```ts
import { AgentJournal } from "cairn";

const journal = new AgentJournal({ actor: "Claude Code" });
```

Options: `{ cwd?, actor?, sessionId?, dbPath?, projectId?, snapshotPolicy?, autoGit? }`.
Pass `dbPath` (e.g. `":memory:"` or a temp file) to use a journal outside a
discovered `.agent/` directory — handy for tests and embedding.

## Lifecycle

```ts
AgentJournal.init();              // create .agent/ in cwd
journal.isInitialized();
journal.manifest();
journal.git();                    // { isRepo, branch, commit }
journal.close();
```

## Appending

```ts
journal.appendEvent({ type: "decision.made", payload: { title: "Use SQLite" } });
journal.append("file.modified", { path: "src/a.ts" });
journal.batchAppend([{ type: "custom.a" }, { type: "custom.b" }]); // atomic
```

### Convenience emitters

```ts
journal.registerAgent();                 // or registerAgent("Codex", { type })
journal.heartbeat();
const g = journal.createGoal({ title: "Launch" });
const { id } = journal.createTask({ title: "OAuth", priority: "high" });
journal.startTask(id);
journal.blockTask(id, "waiting on infra");
journal.completeTask(id);
const d = journal.decide({ title: "Use SQLite", rationale: "WAL", supersedes });
journal.revertDecision(d.id);
journal.learn("Rate limit is 100/s");
journal.recordMemory("User prefers tabs", ["pref"]);
journal.fileTouched("src/a.ts", "modified");
```

## Reading (derivations)

```ts
const state = journal.getState();             // DerivedState
const ctx = journal.getContext("small");      // CompiledContext (also logs context.generated)
const days = journal.getTimeline();           // grouped by date
const text = journal.renderTimeline();        // human-readable string
const mem = journal.getMemory();              // MemoryEntry[]
const know = journal.getKnowledge();          // valid Knowledge[]
const events = journal.events({ types: ["task.created"] });
```

## Operations

```ts
journal.snapshot();    // force a snapshot, returns seq
journal.compact();     // { before, after } pages
journal.health();      // HealthMetrics
journal.validate();    // IntegrityReport
journal.repair();      // RepairReport
journal.exportEvents();
```

## Low-level building blocks

The store, reducers and engines are exported for embedding or building custom
projections:

```ts
import { EventStore, foldState, deriveState, compileContext } from "cairn";

const store = new EventStore(":memory:", { projectId: "demo" });
store.appendEvent({ type: "task.created", payload: { id: "t1", title: "X" } });
const state = deriveState(store);
const ctx = compileContext(store, { level: "medium", state });
```

## Future SDKs

The protocol is language-agnostic; the on-disk format (SQLite + the JSON event
shape) is the contract. Python, Go and Rust SDKs are on the [roadmap](ROADMAP.md)
and interoperate via the same `.agent/journal.db`.
