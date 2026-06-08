import type { EventStore } from "../core/store.js";
import type { DerivedState } from "../core/types.js";
import {
  applyEvent,
  builderFromState,
  agentLiveness,
  Builder,
} from "../reducers/index.js";
import { latestSnapshot } from "./snapshots.js";

/** Full cold-path replay: archive + hot events, optionally up to `maxSeq`. */
function fullReplay(
  store: EventStore,
  projectId: string,
  now: number,
  maxSeq?: number,
): DerivedState {
  const b = new Builder(projectId);
  for (const ev of store.streamEvents({ includeArchive: true })) {
    if (maxSeq !== undefined && ev.seq > maxSeq) break;
    applyEvent(b, ev);
  }
  const state = b.materialize();
  for (const a of state.agents) a.liveness = agentLiveness(a, now);
  return state;
}

/**
 * State engine — derives current state from the journal.
 *
 * Fast path: load the latest snapshot and replay only the events appended since.
 * Cold path (or `fromScratch`): fold the entire history. Both yield identical
 * results because reducers are deterministic — the snapshot is just a cache.
 */
export function deriveState(
  store: EventStore,
  opts: { atSeq?: number; fromScratch?: boolean; now?: number } = {},
): DerivedState {
  const now = opts.now ?? Date.now();
  const maxSeq = opts.atSeq;

  if (opts.fromScratch) {
    return fullReplay(store, store.projectId, now, maxSeq);
  }

  const snap = latestSnapshot(store, maxSeq);
  if (!snap) {
    return fullReplay(store, store.projectId, now, maxSeq);
  }

  // Resume from the snapshot and replay the tail.
  const b = builderFromState(snap.state);
  const tail = store.streamEvents({ sinceSeq: snap.seq });
  for (const ev of tail) {
    if (maxSeq !== undefined && ev.seq > maxSeq) break;
    applyEvent(b, ev);
  }
  const state = b.materialize();
  for (const a of state.agents) a.liveness = agentLiveness(a, now);
  return state;
}

// --- Convenience selectors over derived state --------------------------------

/** Active (non-archived, non-completed) tasks. */
export function activeTasks(state: DerivedState) {
  return state.tasks.filter(
    (t) => t.status !== "completed" && t.status !== "archived",
  );
}

/** Decisions currently in force. */
export function activeDecisions(state: DerivedState) {
  return state.decisions.filter((d) => d.status === "active");
}

/** Goals not archived. */
export function activeGoals(state: DerivedState) {
  return state.goals.filter((g) => g.status === "active");
}

/** Agents considered live right now. */
export function activeAgents(state: DerivedState) {
  return state.agents.filter((a) => a.liveness === "active");
}
