import type { EventStore } from "../core/store.js";
import type { DerivedState, Knowledge, JournalEvent } from "../core/types.js";
import { deriveState } from "./state.js";
import { buildTimeline, type TimelineDay } from "./timeline.js";
import { compileContext, type CompiledContext, type ContextLevel } from "./context.js";

/**
 * Memory layer — everything is derived from the journal, nothing is stored
 * separately. "Memory", "knowledge", "timeline", "state" and "context" are all
 * just different projections over the same immutable event stream.
 */

/** A recorded memory entry, projected from `memory.recorded` events. */
export interface MemoryEntry {
  id: string;
  at: string;
  actor: string;
  content: string;
  tags: string[];
  archived: boolean;
}

/** Project memories from the journal (`memory.recorded` / `memory.archived`). */
export function deriveMemory(store: EventStore): MemoryEntry[] {
  const memories = new Map<string, MemoryEntry>();
  for (const ev of store.streamEvents()) {
    const p = ev.payload;
    if (ev.type === "memory.recorded") {
      const id = typeof p["id"] === "string" ? p["id"] : ev.id;
      memories.set(id, {
        id,
        at: ev.timestamp,
        actor: ev.actor,
        content: typeof p["content"] === "string" ? p["content"] : typeof p["text"] === "string" ? (p["text"] as string) : "",
        tags: Array.isArray(p["tags"]) ? (p["tags"] as string[]).filter((t) => typeof t === "string") : [],
        archived: false,
      });
    } else if (ev.type === "memory.archived") {
      const m = memories.get(typeof p["id"] === "string" ? p["id"] : "");
      if (m) m.archived = true;
    }
  }
  return [...memories.values()].filter((m) => !m.archived);
}

/** Derive currently-valid knowledge from the event stream. */
export function deriveKnowledge(
  store: EventStore,
  opts: { includeInvalid?: boolean } = {},
): Knowledge[] {
  const state = deriveState(store);
  return opts.includeInvalid
    ? state.knowledge
    : state.knowledge.filter((k) => k.valid);
}

/** Derive a human-readable timeline grouped by day. */
export function deriveTimeline(
  store: EventStore,
  opts: { sinceSeq?: number; types?: string[] } = {},
): TimelineDay[] {
  const events: Iterable<JournalEvent> = opts.types?.length
    ? store.queryEvents({
        types: opts.types,
        ...(opts.sinceSeq !== undefined ? { sinceSeq: opts.sinceSeq } : {}),
      })
    : store.streamEvents(opts.sinceSeq !== undefined ? { sinceSeq: opts.sinceSeq } : {});
  return buildTimeline(events);
}

/** Derive current state (re-exported for the memory API surface). */
export function deriveStateFor(store: EventStore): DerivedState {
  return deriveState(store);
}

/** Derive compiled context at a level. */
export function deriveContext(
  store: EventStore,
  level: ContextLevel = "medium",
): CompiledContext {
  return compileContext(store, { level });
}
