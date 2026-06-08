import type { JournalEvent } from "../core/types.js";
import { dateOf } from "../core/ids.js";

/** A single human-readable timeline entry. */
export interface TimelineEntry {
  seq: number;
  timestamp: string;
  actor: string;
  type: string;
  /** One-line human summary. */
  summary: string;
}

/** Timeline entries grouped by calendar date. */
export interface TimelineDay {
  date: string;
  entries: TimelineEntry[];
}

function summarize(ev: JournalEvent): string {
  const p = ev.payload;
  const s = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : "");
  switch (ev.type) {
    case "goal.created":
      return `Goal created: ${s("title")}`;
    case "goal.archived":
      return `Goal archived: ${s("title") || s("id")}`;
    case "task.created":
      return `Task created: ${s("title")}`;
    case "task.started":
      return `Task started: ${s("title") || s("id")}`;
    case "task.blocked":
      return `Task blocked: ${s("title") || s("id")}${s("reason") ? ` (${s("reason")})` : ""}`;
    case "task.completed":
      return `Task completed: ${s("title") || s("id")}`;
    case "decision.made":
      return `Decision: ${s("title")}${s("rationale") ? ` — ${s("rationale")}` : ""}`;
    case "decision.superseded":
      return `Decision superseded: ${s("id")}`;
    case "decision.reverted":
      return `Decision reverted: ${s("id")}`;
    case "knowledge.learned":
      return `Learned: ${s("statement") || s("text")}`;
    case "agent.registered":
      return `Agent joined: ${s("name") || ev.actor}`;
    case "agent.disconnected":
      return `Agent left: ${s("name") || ev.actor}`;
    case "file.created":
      return `Created ${s("path")}`;
    case "file.modified":
      return `Modified ${s("path")}`;
    case "file.deleted":
      return `Deleted ${s("path")}`;
    case "session.started":
      return `Session started`;
    case "session.ended":
      return `Session ended`;
    default:
      return ev.type;
  }
}

/** Build a single flat list of timeline entries from events. */
export function timelineEntries(events: Iterable<JournalEvent>): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  for (const ev of events) {
    out.push({
      seq: ev.seq,
      timestamp: ev.timestamp,
      actor: ev.actor,
      type: ev.type,
      summary: summarize(ev),
    });
  }
  return out;
}

/** Group timeline entries by calendar date (ascending). */
export function buildTimeline(events: Iterable<JournalEvent>): TimelineDay[] {
  const days = new Map<string, TimelineEntry[]>();
  for (const e of timelineEntries(events)) {
    const d = dateOf(e.timestamp);
    const bucket = days.get(d) ?? [];
    bucket.push(e);
    days.set(d, bucket);
  }
  return [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, entries]) => ({ date, entries }));
}

/** Render a timeline to human-readable text. */
export function renderTimeline(days: TimelineDay[]): string {
  if (days.length === 0) return "(no activity yet)";
  const lines: string[] = [];
  for (const day of days) {
    lines.push(day.date);
    for (const e of day.entries) {
      lines.push(`  ${e.summary}${e.actor ? `  — ${e.actor}` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}
