import type { Decision } from "./types.js";
import { writeText } from "./io.js";
import { statedPaths } from "./paths.js";
import { decisionId, nowIso, today } from "./ids.js";
import { appendEvent, decisionsFromEvents } from "./events.js";
import { regenerate } from "./snapshot.js";

/**
 * Decisions are canonically stored in the append-only event stream and
 * rendered to the human-readable `.stated/decisions.md`. This keeps history
 * immutable (you cannot silently rewrite a past decision) while still producing
 * a clean, diffable Markdown log grouped by date.
 */

/** All decisions, newest-first. */
export function readDecisions(root: string): Decision[] {
  return decisionsFromEvents(root);
}

export interface AddDecisionInput {
  decision: string;
  reason?: string;
  madeBy?: string;
  date?: string;
}

/** Record a decision and regenerate `decisions.md` + the snapshot. */
export function addDecision(
  root: string,
  input: AddDecisionInput,
  actor?: string,
): Decision {
  const text = input.decision.trim();
  if (!text) throw new Error("Decision text cannot be empty.");
  const decision: Decision = {
    id: decisionId(),
    date: input.date?.trim() || today(),
    decision: text,
    reason: input.reason?.trim() ?? "",
    madeBy: input.madeBy?.trim() || actor || "unknown",
    createdAt: nowIso(),
  };
  appendEvent(root, "decision_added", {
    actor: decision.madeBy,
    data: { ...decision },
  });
  renderDecisionsFile(root);
  regenerate(root);
  return decision;
}

/** Render the decisions Markdown file from the canonical event stream. */
export function renderDecisionsFile(root: string): void {
  const decisions = readDecisions(root);
  writeText(statedPaths(root).decisions, renderDecisions(decisions));
}

/** Produce the `decisions.md` body for a list of decisions (newest-first). */
export function renderDecisions(decisions: Decision[]): string {
  const lines: string[] = ["# Decisions", ""];
  if (decisions.length === 0) {
    lines.push("_No decisions recorded yet._", "");
    return lines.join("\n");
  }

  // Group by date, preserving newest-first order of first appearance.
  const byDate = new Map<string, Decision[]>();
  for (const d of decisions) {
    const bucket = byDate.get(d.date) ?? [];
    bucket.push(d);
    byDate.set(d.date, bucket);
  }

  for (const [date, items] of byDate) {
    lines.push(`## ${date}`, "");
    for (const d of items) {
      lines.push(`Decision:`, d.decision, "");
      if (d.reason) lines.push(`Reason:`, d.reason, "");
      lines.push(`Made By:`, d.madeBy, "");
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
