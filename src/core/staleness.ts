import type {
  Confidence,
  FileOwnership,
  FileView,
  Freshness,
  Task,
  TaskView,
} from "./types.js";
import {
  type StatedConfig,
  type DecayKind,
  thresholdsFor,
  tierFor,
} from "./config.js";

/**
 * Staleness derivation.
 *
 * Confidence is never stored — it is always computed from how long ago a fact
 * was last verified, relative to the current time. This is what lets `.stated/`
 * decay *visibly* instead of silently lying: a fact that hasn't been touched or
 * confirmed in weeks renders as `stale` the moment anyone reads it.
 */

/** The effective "last verified" instant for a task (falls back to updatedAt). */
export function taskVerifiedAt(task: Task): string {
  return task.lastVerifiedAt ?? task.updatedAt;
}

/** The effective "last verified" instant for a file claim (falls back to claimedAt). */
export function fileVerifiedAt(file: FileOwnership): string {
  return file.lastVerifiedAt ?? file.claimedAt;
}

/** Age in milliseconds of an ISO timestamp relative to `now`. Never negative. */
export function ageMsOf(iso: string, now: number): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, now - t);
}

/** Derive a {@link Confidence} for an age and decaying kind. */
export function confidenceFor(
  kind: DecayKind,
  iso: string,
  now: number,
  config: StatedConfig,
): Confidence {
  return tierFor(ageMsOf(iso, now), thresholdsFor(config, kind));
}

/** Annotate a task with its derived confidence + age. */
export function viewTask(
  task: Task,
  now: number,
  config: StatedConfig,
): TaskView {
  const iso = taskVerifiedAt(task);
  return {
    ...task,
    confidence: confidenceFor("task", iso, now, config),
    ageMs: ageMsOf(iso, now),
  };
}

/** Annotate a file claim with its derived confidence + age. */
export function viewFile(
  file: FileOwnership,
  now: number,
  config: StatedConfig,
): FileView {
  const iso = fileVerifiedAt(file);
  return {
    ...file,
    confidence: confidenceFor("lock", iso, now, config),
    ageMs: ageMsOf(iso, now),
  };
}

const RANK: Record<Confidence, number> = { fresh: 0, aging: 1, stale: 2 };

/** Aggregate per-fact confidences into a project {@link Freshness} banner. */
export function summarize(
  items: Array<{ confidence: Confidence; iso: string }>,
): Freshness {
  const counts = { fresh: 0, aging: 0, stale: 0 };
  let overall: Confidence = "fresh";
  let lastActivityAt: string | null = null;

  for (const it of items) {
    counts[it.confidence]++;
    if (RANK[it.confidence] > RANK[overall]) overall = it.confidence;
    if (lastActivityAt === null || it.iso > lastActivityAt) {
      lastActivityAt = it.iso;
    }
  }
  return { overall, counts, lastActivityAt };
}

/**
 * Human-friendly relative age, e.g. "just now", "3h", "2 days", "5 weeks".
 * Coarse on purpose — handoff readers want a glance, not a stopwatch.
 */
export function ageLabel(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 14) return `${day} day${day === 1 ? "" : "s"}`;
  const wk = Math.floor(day / 7);
  if (wk < 9) return `${wk} weeks`;
  const mo = Math.floor(day / 30);
  if (mo < 24) return `${mo} month${mo === 1 ? "" : "s"}`;
  return `${Math.floor(day / 365)} years`;
}

/** A short symbol + word for a confidence, for inline rendering. */
export function confidenceBadge(c: Confidence): string {
  if (c === "stale") return "⚠ stale";
  if (c === "aging") return "aging";
  return "fresh";
}
