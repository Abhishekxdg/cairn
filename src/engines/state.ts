import type { EventStore } from "../core/store.js";
import type { Anchor, DerivedState } from "../core/types.js";
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

/**
 * Foundational facts that must survive into every context (the memory-residual
 * "shortcut wire"): anchored decisions still in force + anchored/durable
 * knowledge still valid.
 *
 * Ranked so that when anchors out-grow the budget the RIGHT ones survive:
 * higher `weight` first, then more recent, then decisions before knowledge
 * (a stable, deterministic tiebreak). Equal-weight anchors keep the old
 * decisions-then-knowledge feel via the final tiebreak.
 */
export function anchors(state: DerivedState): Anchor[] {
  const out: Anchor[] = [];
  for (const d of state.decisions) {
    if (d.anchor && d.status === "active") {
      out.push({
        kind: "decision",
        id: d.id,
        text: d.rationale ? `${d.title} — ${d.rationale}` : d.title,
        weight: d.weight ?? 0,
        at: d.createdAt,
      });
    }
  }
  for (const k of state.knowledge) {
    if (k.anchor && k.valid) {
      out.push({ kind: "knowledge", id: k.id, text: k.statement, weight: k.weight ?? 0, at: k.createdAt });
    }
  }
  out.sort(
    (a, b) =>
      b.weight - a.weight ||
      b.at.localeCompare(a.at) ||
      (a.kind === b.kind ? 0 : a.kind === "decision" ? -1 : 1),
  );
  return out;
}

/** Agents considered live right now. */
export function activeAgents(state: DerivedState) {
  return state.agents.filter((a) => a.liveness === "active");
}
