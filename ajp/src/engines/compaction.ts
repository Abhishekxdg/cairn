import type { EventStore } from "../core/store.js";
import { deriveState } from "./state.js";
import { latestSnapshot, createSnapshot } from "./snapshots.js";

/**
 * Journal compaction — keep the hot event table small at 10M+ scale without
 * ever losing history.
 *
 * Events older than a covering snapshot are cold-archived (moved to
 * `events_archive`, still in the journal, still exportable). A snapshot at the
 * cut point guarantees state remains reconstructable: normal derivation resumes
 * from the snapshot, and full replay reads archive + hot in order.
 */

export interface CompactionReport {
  archived: number;
  remaining: number;
  cutSeq: number;
  snapshotSeq: number;
}

/**
 * Compact the journal, archiving events up to the most recent snapshot (or
 * creating one first). `keepRecent` leaves the newest N events in the hot table
 * regardless, so recent history stays instantly queryable.
 */
export function compactJournal(
  store: EventStore,
  opts: { keepRecent?: number } = {},
): CompactionReport {
  const keepRecent = opts.keepRecent ?? 0;

  // Ensure a snapshot exists to cover the cut point.
  let snap = latestSnapshot(store);
  if (!snap) {
    snap = createSnapshot(store, deriveState(store, { fromScratch: true }));
  }

  // Never archive past `keepRecent` newest events, nor past the snapshot.
  const lastSeq = store.lastSeq();
  const keepFloor = keepRecent > 0 ? lastSeq - keepRecent : lastSeq;
  const cutSeq = Math.max(0, Math.min(snap.seq, keepFloor));

  if (cutSeq <= 0) {
    return { archived: 0, remaining: store.count(), cutSeq: 0, snapshotSeq: snap.seq };
  }

  const { archived, remaining } = store.compactEvents(cutSeq);
  return { archived, remaining, cutSeq, snapshotSeq: snap.seq };
}
