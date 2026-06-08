import type { StatedEvent, EventType, Decision } from "./types.js";
import { appendLine, readJsonl } from "./io.js";
import { statedPaths } from "./paths.js";
import { nowIso } from "./ids.js";

/**
 * The append-only event log (`.stated/events.jsonl`).
 *
 * Events are the immutable history of the project. Mutable files (tasks.json,
 * agents.json, ...) hold current state; the event stream holds how we got there.
 * Decisions are special: the event stream is their *canonical* store, and
 * `decisions.md` is regenerated from it.
 */

/** Append an event to the stream. */
export function appendEvent(
  root: string,
  type: EventType,
  opts: { actor?: string; data?: Record<string, unknown> } = {},
): StatedEvent {
  const event: StatedEvent = {
    type,
    at: nowIso(),
    ...(opts.actor ? { actor: opts.actor } : {}),
    ...(opts.data ? { data: opts.data } : {}),
  };
  appendLine(statedPaths(root).events, JSON.stringify(event));
  return event;
}

/** Read the full event stream. */
export function readEvents(root: string): StatedEvent[] {
  return readJsonl<StatedEvent>(statedPaths(root).events);
}

/** Read the most recent `n` events (newest last). */
export function recentEvents(root: string, n: number): StatedEvent[] {
  const all = readEvents(root);
  return all.slice(Math.max(0, all.length - n));
}

/**
 * Reconstruct the canonical list of decisions from the event stream.
 * Returned newest-first.
 */
export function decisionsFromEvents(root: string): Decision[] {
  const byId = new Map<string, Decision>();
  const order: string[] = [];
  for (const ev of readEvents(root)) {
    if (ev.type === "decision_added" && ev.data) {
      const d = ev.data as Partial<Decision>;
      if (!d.id || !d.decision) continue;
      byId.set(d.id, {
        id: d.id,
        status: d.status ?? "active",
        ...(d.supersededBy ? { supersededBy: d.supersededBy } : {}),
        date: d.date ?? ev.at.slice(0, 10),
        decision: d.decision,
        reason: d.reason ?? "",
        madeBy: d.madeBy ?? ev.actor ?? "unknown",
        createdAt: d.createdAt ?? ev.at,
        ...(d.runId ? { runId: d.runId } : {}),
      });
      order.push(d.id);
      continue;
    }
    if (ev.type === "decision_superseded" && ev.data) {
      const oldId = String(ev.data["id"] ?? "");
      const supersededBy = String(ev.data["supersededBy"] ?? "");
      const existing = byId.get(oldId);
      if (!existing || !supersededBy) continue;
      existing.status = "superseded";
      existing.supersededBy = supersededBy;
    }
  }
  return order
    .map((id) => byId.get(id))
    .filter((d): d is Decision => Boolean(d))
    .reverse();
}
