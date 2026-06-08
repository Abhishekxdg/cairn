import type { Decision } from "./types.js";
import { writeText, withProjectLock } from "./io.js";
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
  /** Existing decision id this decision replaces. */
  supersedes?: string;
  /** Optional session/run scope for this decision. */
  runId?: string;
}

/** Record a decision and regenerate `decisions.md` + the snapshot. */
export function addDecision(
  root: string,
  input: AddDecisionInput,
  actor?: string,
): Decision {
  return withProjectLock(root, () => {
    const text = input.decision.trim();
    if (!text) throw new Error("Decision text cannot be empty.");
    const decision: Decision = {
      id: decisionId(),
      status: "active",
      date: input.date?.trim() || today(),
      decision: text,
      reason: input.reason?.trim() ?? "",
      madeBy: input.madeBy?.trim() || actor || "unknown",
      createdAt: nowIso(),
      ...(input.runId?.trim() ? { runId: input.runId.trim() } : {}),
    };
    appendEvent(root, "decision_added", {
      actor: decision.madeBy,
      data: { ...decision },
    });
    if (input.supersedes?.trim()) {
      supersedeDecision(
        root,
        input.supersedes.trim(),
        decision.id,
        decision.madeBy,
      );
    }
    renderDecisionsFile(root);
    regenerate(root);
    return decision;
  });
}

/** Mark an older decision superseded by a newer active decision. */
export function supersedeDecision(
  root: string,
  id: string,
  supersededBy: string,
  actor?: string,
): Decision {
  return withProjectLock(root, () => {
    const decisions = readDecisions(root);
    const current = decisions.find((d) => d.id === id);
    if (!current) throw new Error(`No decision with id "${id}".`);
    const replacement = decisions.find((d) => d.id === supersededBy);
    if (!replacement) {
      throw new Error(`No replacement decision with id "${supersededBy}".`);
    }
    appendEvent(root, "decision_superseded", {
      ...(actor ? { actor } : {}),
      data: { id, supersededBy },
    });
    renderDecisionsFile(root);
    regenerate(root);
    return { ...current, status: "superseded", supersededBy };
  });
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
      const suffix =
        d.status === "superseded" ? ` (superseded by ${d.supersededBy})` : "";
      lines.push(`Decision${suffix}:`, d.decision, "");
      if (d.reason) lines.push(`Reason:`, d.reason, "");
      lines.push(`Made By:`, d.madeBy, "");
    }
  }
  return (
    lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n"
  );
}
