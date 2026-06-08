import type { EventStore } from "../core/store.js";
import type { AgentRecord } from "../core/types.js";
import { deriveState } from "./state.js";
import { AGENT_ACTIVE_WINDOW_MS } from "../reducers/index.js";

/**
 * Agent registry operations: stale detection + automatic pruning.
 *
 * Pruning is event-sourced — a pruned agent is not deleted from history, it is
 * recorded as `agent.disconnected`, which flips its derived liveness to
 * `offline`. The registry therefore stays a pure projection of the journal.
 */

/** Default idle window before an agent is eligible for pruning (1 hour). */
export const PRUNE_IDLE_MS = 4 * AGENT_ACTIVE_WINDOW_MS;

/** Agents whose last heartbeat is older than `idleMs` and not yet offline. */
export function staleAgents(
  store: EventStore,
  opts: { idleMs?: number; now?: number } = {},
): AgentRecord[] {
  const idleMs = opts.idleMs ?? PRUNE_IDLE_MS;
  const now = opts.now ?? Date.now();
  const state = deriveState(store, { now });
  return state.agents.filter((a) => {
    if (a.liveness === "offline") return false;
    const seen = Date.parse(a.lastSeen);
    return !Number.isNaN(seen) && now - seen >= idleMs;
  });
}

export interface PruneReport {
  pruned: string[];
}

/**
 * Prune stale agents by appending `agent.disconnected` events for each.
 * Idempotent: an already-offline agent is never re-pruned.
 */
export function pruneAgents(
  store: EventStore,
  opts: { idleMs?: number; now?: number; actor?: string } = {},
): PruneReport {
  const stale = staleAgents(store, opts);
  for (const a of stale) {
    store.appendEvent({
      type: "agent.disconnected",
      actor: opts.actor ?? "cairn",
      payload: { name: a.name, reason: "pruned (stale)" },
    });
  }
  return { pruned: stale.map((a) => a.name) };
}
