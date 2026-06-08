import type { Goals } from "./types.js";
import { readText, writeText } from "./io.js";
import { statedPaths } from "./paths.js";
import { bulletsUnderHeading } from "./markdown.js";
import { appendEvent } from "./events.js";

/**
 * Goals live in `.stated/goals.md` as two bullet lists under `## Active` and
 * `## Completed`. We keep the markdown canonical (humans edit it) but provide a
 * structured read/write API so the CLI, SDK and snapshot engine stay in sync.
 */

/** Read goals from `.stated/goals.md`. */
export function readGoals(root: string): Goals {
  const md = readText(statedPaths(root).goals);
  return {
    active: bulletsUnderHeading(md, "Active"),
    completed: bulletsUnderHeading(md, "Completed"),
  };
}

/** Render a {@link Goals} object to the canonical `goals.md` layout. */
export function renderGoals(goals: Goals): string {
  const section = (title: string, items: string[]) =>
    [`## ${title}`, "", ...(items.length ? items.map((g) => `- ${g}`) : []), ""];
  return [
    "# Goals",
    "",
    ...section("Active", goals.active),
    ...section("Completed", goals.completed),
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd() + "\n";
}

/** Write goals back to `.stated/goals.md`. */
export function writeGoals(root: string, goals: Goals): void {
  writeText(statedPaths(root).goals, renderGoals(goals));
}

/** Add a new active goal. No-op (idempotent) if it already exists active. */
export function addGoal(root: string, goal: string, actor?: string): Goals {
  const text = goal.trim();
  if (!text) throw new Error("Goal text cannot be empty.");
  const goals = readGoals(root);
  if (!goals.active.includes(text)) {
    goals.active.push(text);
    writeGoals(root, goals);
    appendEvent(root, "goal_added", {
      ...(actor ? { actor } : {}),
      data: { goal: text },
    });
  }
  return goals;
}

/**
 * Mark an active goal completed. Matches case-insensitively on a substring so
 * `stated goal complete oauth` resolves "OAuth Integration".
 */
export function completeGoal(root: string, query: string, actor?: string): Goals {
  const q = query.trim().toLowerCase();
  if (!q) throw new Error("Goal query cannot be empty.");
  const goals = readGoals(root);
  const idx = goals.active.findIndex((g) => g.toLowerCase().includes(q));
  if (idx === -1) {
    throw new Error(`No active goal matching "${query}".`);
  }
  const [done] = goals.active.splice(idx, 1);
  if (done && !goals.completed.includes(done)) goals.completed.push(done);
  writeGoals(root, goals);
  appendEvent(root, "goal_completed", {
    ...(actor ? { actor } : {}),
    data: { goal: done },
  });
  return goals;
}
