# Concurrency & Durability

The hardest requirement in the protocol: **multiple agents may write
simultaneously, and the journal must guarantee no lost updates, no partial
writes, no corruption, no race conditions.**

## Why JSON files fail

A naive shared-state file uses read-modify-write:

```text
Claude: read tasks.json (A) ─┐
Codex:  read tasks.json (A) ─┤   both see A
Claude: write A + task1   ───┤   → file = A+task1
Codex:  write A + task2   ───┘   → file = A+task2   (task1 LOST)
```

Atomic rename prevents a *torn* file but not a *lost update*. This is fatal for a
coordination layer. Cairn does not do read-modify-write.

## How Cairn guarantees it

1. **Append-only, single-row inserts.** Changing state means appending one event
   — `INSERT INTO events …`. There is no read-modify-write to race.
2. **SQLite WAL.** Write-Ahead Logging allows one writer and many concurrent
   readers without blocking. Writers are serialized by the engine; readers see a
   consistent snapshot.
3. **`busy_timeout`.** Concurrent writers wait (up to 5s) for the write lock
   instead of failing, so bursts from several agents succeed.
4. **Gap-free `seq`.** `AUTOINCREMENT` assigns a monotonic, unique sequence to
   every committed event — the total order, with no holes.
5. **Idempotency via `id`.** A unique ULID per event lets retries / at-least-once
   delivery dedupe (`INSERT OR IGNORE`), so a re-sent event is a no-op.
6. **Transactions.** `batchAppend` writes all-or-nothing inside a transaction.

## What the tests prove

`test/concurrency.test.ts`:

- **In-process interleaving** — 1000 interleaved appends from two logical
  writers produce a gap-free `[1..1000]` sequence.
- **Multi-process race** — 4 OS processes each append 250 events to the same
  `journal.db` in parallel. Afterward: `count == 1000`, all `seq` values unique
  and gap-free, and SQLite `integrity_check == ok`. No lost updates, no
  corruption.

## Durability / crash recovery

- `synchronous = NORMAL` with WAL: committed transactions survive process crash
  and OS-level interruptions; only an OS/power crash mid-checkpoint risks the
  last uncheckpointed WAL frames, which WAL recovers on reopen.
- `test/store.test.ts` proves reopening a database (without a clean close) sees
  all previously committed events.

## Snapshots and concurrency

Snapshots are written as ordinary rows pinned to a `seq`; concurrent appends
continue past the snapshot. Deriving state from `snapshot + tail` is always
consistent because reducers are deterministic and the tail is read in `seq`
order.

## Multi-machine / networked filesystems

SQLite locking is unreliable over some network filesystems (NFS, SMB). Cairn is
**local-first** by design: the journal lives beside the code on a local disk. A
networked/remote-sync backend is a future, explicitly-scoped layer
(see [ROADMAP.md](ROADMAP.md)), not the default.
