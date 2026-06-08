import type { EventStore } from "../core/store.js";
import type { DerivedState } from "../core/types.js";
import { ulid, nowIso } from "../core/ids.js";

/**
 * Snapshot engine.
 *
 * Snapshots are pure optimization: a materialized {@link DerivedState} pinned to
 * a sequence number so state can be rebuilt by replaying only the events *after*
 * the snapshot instead of the whole journal. Every snapshot is fully
 * reconstructable from events — losing them costs time, never truth.
 */

export interface SnapshotRow {
  id: string;
  seq: number;
  timestamp: string;
  state: DerivedState;
}

/** Auto-snapshot policy: take one every N events or T milliseconds. */
export interface SnapshotPolicy {
  everyEvents: number;
  everyMs: number;
}

export const DEFAULT_SNAPSHOT_POLICY: SnapshotPolicy = {
  everyEvents: 100,
  everyMs: 5 * 60 * 1000,
};

/** Persist a state snapshot at the current sequence. */
export function createSnapshot(store: EventStore, state: DerivedState): SnapshotRow {
  const row: SnapshotRow = {
    id: ulid(),
    seq: state.lastSeq,
    timestamp: nowIso(),
    state,
  };
  store.db
    .prepare(
      "INSERT INTO snapshots(id, seq, timestamp, state) VALUES(?, ?, ?, ?)",
    )
    .run(row.id, row.seq, row.timestamp, JSON.stringify(state));
  return row;
}

/** The most recent snapshot at or before `maxSeq` (default: latest). */
export function latestSnapshot(
  store: EventStore,
  maxSeq?: number,
): SnapshotRow | undefined {
  const raw = (
    maxSeq === undefined
      ? store.db
          .prepare("SELECT * FROM snapshots ORDER BY seq DESC LIMIT 1")
          .get()
      : store.db
          .prepare(
            "SELECT * FROM snapshots WHERE seq <= ? ORDER BY seq DESC LIMIT 1",
          )
          .get(maxSeq)
  ) as
    | { id: string; seq: number; timestamp: string; state: string }
    | undefined;
  if (!raw) return undefined;
  return {
    id: raw.id,
    seq: raw.seq,
    timestamp: raw.timestamp,
    state: JSON.parse(raw.state) as DerivedState,
  };
}

/** Whether policy says a fresh snapshot is due. */
export function snapshotDue(
  store: EventStore,
  policy: SnapshotPolicy = DEFAULT_SNAPSHOT_POLICY,
  now: number = Date.now(),
): boolean {
  const latest = latestSnapshot(store);
  const lastSeq = store.lastSeq();
  if (!latest) return lastSeq > 0;
  if (lastSeq - latest.seq >= policy.everyEvents) return true;
  if (now - Date.parse(latest.timestamp) >= policy.everyMs) return true;
  return false;
}

/** Count of stored snapshots. */
export function snapshotCount(store: EventStore): number {
  return (
    store.db.prepare("SELECT COUNT(*) AS c FROM snapshots").get() as {
      c: number;
    }
  ).c;
}
