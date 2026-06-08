import { join } from "node:path";
import type { State, Task, TaskView, FileView } from "./types.js";
import { ensureDir, writeJson, writeText, withProjectLock } from "./io.js";
import { statedPaths } from "./paths.js";
import { nowIso } from "./ids.js";
import { readProject } from "./project.js";
import { readGoals } from "./goals.js";
import { readTasks, activeTasks } from "./tasks.js";
import { readDecisions } from "./decisions.js";
import { readAgents, liveStatus } from "./agents.js";
import { lockedFiles } from "./files.js";
import { detectFrameworks } from "./framework.js";
import { appendEvent } from "./events.js";
import { loadConfig } from "./config.js";
import {
  viewTask,
  viewFile,
  summarize,
  ageLabel,
  confidenceBadge,
  taskVerifiedAt,
  fileVerifiedAt,
} from "./staleness.js";

/**
 * The snapshot engine.
 *
 * Whenever project state changes, {@link regenerate} rebuilds the two derived
 * files agents read most: the machine-optimized `state.json` and the
 * human/AI-readable `handoff.md`. Everything here is pure derivation from the
 * canonical files — it never invents data.
 */

const PRIORITY_RANK: Record<Task["priority"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** Order tasks by status (active first) then priority then recency. */
function rankTasks(tasks: Task[]): Task[] {
  const statusRank: Record<Task["status"], number> = {
    active: 0,
    claimed: 1,
    blocked: 2,
    todo: 3,
    completed: 4,
  };
  return [...tasks].sort((a, b) => {
    if (statusRank[a.status] !== statusRank[b.status]) {
      return statusRank[a.status] - statusRank[b.status];
    }
    if (PRIORITY_RANK[a.priority] !== PRIORITY_RANK[b.priority]) {
      return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    }
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

/** Build the in-memory {@link State} for a project without writing it. */
export function buildState(root: string, nowMs = Date.now()): State {
  const project = readProject(root);
  const goals = readGoals(root);
  const config = loadConfig(root);
  const tasks: TaskView[] = rankTasks(activeTasks(root)).map((t) =>
    viewTask(t, nowMs, config),
  );
  const files: FileView[] = lockedFiles(root).map((f) =>
    viewFile(f, nowMs, config),
  );
  const decisions = readDecisions(root)
    .filter((d) => d.status === "active")
    .slice(0, 5);
  const agents = readAgents(root)
    .map((a) => ({ ...a, status: liveStatus(a, nowMs) }))
    .filter((a) => a.status === "active");

  const freshness = summarize([
    ...tasks.map((t) => ({ confidence: t.confidence, iso: taskVerifiedAt(t) })),
    ...files.map((f) => ({ confidence: f.confidence, iso: fileVerifiedAt(f) })),
  ]);

  return {
    version: 1,
    goal: goals.active[0] ?? "",
    project,
    goals,
    activeTasks: tasks,
    recentDecisions: decisions,
    activeAgents: agents,
    lockedFiles: files,
    frameworks: detectFrameworks(root),
    freshness,
    generatedAt: nowIso(),
  };
}

/**
 * Compute the next recommended steps for the handoff. Pure heuristic over the
 * current task board — no model involved.
 */
export function nextSteps(state: State): string[] {
  const steps: string[] = [];
  const blocked = state.activeTasks.filter((t) => t.status === "blocked");
  const inProgress = state.activeTasks.filter((t) => t.status === "active");
  const claimed = state.activeTasks.filter((t) => t.status === "claimed");
  const todo = state.activeTasks.filter((t) => t.status === "todo");

  for (const t of blocked) steps.push(`Unblock: ${t.title} (${t.id})`);
  for (const t of inProgress) steps.push(`Finish: ${t.title} (${t.id})`);
  for (const t of claimed) steps.push(`Start: ${t.title} (${t.id})`);
  for (const t of todo.slice(0, 3)) {
    steps.push(`Pick up: ${t.title} (${t.id})`);
  }
  if (steps.length === 0) {
    if (state.goal)
      steps.push(`Break down the goal "${state.goal}" into tasks`);
    else steps.push("Define a goal with `stated goal add` and add tasks");
  }
  return steps.slice(0, 7);
}

/** One-line freshness banner summarizing how trustworthy the state is. */
export function freshnessBanner(state: State): string {
  const { counts, lastActivityAt } = state.freshness;
  const total = counts.fresh + counts.aging + counts.stale;
  if (total === 0) return "Freshness: ✓ no active facts to age";
  if (counts.stale === 0 && counts.aging === 0) {
    return "Freshness: ✓ all fresh";
  }
  const parts: string[] = [];
  if (counts.stale) parts.push(`⚠ ${counts.stale} stale`);
  if (counts.aging) parts.push(`${counts.aging} aging`);
  const nowMs = Date.parse(state.generatedAt);
  const last = lastActivityAt
    ? ` — last activity ${ageLabel(nowMs - Date.parse(lastActivityAt))} ago`
    : "";
  return `Freshness: ${parts.join(", ")}${last}`;
}

/** Render the handoff Markdown from a computed {@link State}. */
export function renderHandoff(state: State): string {
  const lines: string[] = ["# Project Handoff", ""];

  const name = state.project.name || "(unnamed project)";
  lines.push(`Project: ${name}`, "");

  lines.push(freshnessBanner(state), "");

  lines.push("Goal:", state.goal || "(no active goal)", "");

  const inProgress = state.activeTasks.find((t) => t.status === "active");
  lines.push(
    "Current Work:",
    inProgress
      ? `${inProgress.title} (${inProgress.id})`
      : "(nothing in progress)",
    "",
  );

  lines.push(
    "Completed:",
    state.goals.completed.length ? state.goals.completed.join(", ") : "(none)",
    "",
  );

  lines.push("Active Tasks:");
  if (state.activeTasks.length) {
    for (const t of state.activeTasks) {
      const owner = t.owner ? ` — ${t.owner}` : "";
      const age =
        t.confidence === "fresh"
          ? ""
          : ` ${confidenceBadge(t.confidence)} (${ageLabel(t.ageMs)})`;
      lines.push(`- [${t.status}] ${t.title} (${t.id})${owner}${age}`);
    }
  } else {
    lines.push("- (none)");
  }
  lines.push("");

  lines.push("Decisions:");
  if (state.recentDecisions.length) {
    for (const d of state.recentDecisions) {
      lines.push(`- ${d.decision}${d.reason ? ` — ${d.reason}` : ""}`);
    }
  } else {
    lines.push("- (none)");
  }
  lines.push("");

  lines.push("Agents:");
  if (state.activeAgents.length) {
    for (const a of state.activeAgents) lines.push(`- ${a.name} (${a.type})`);
  } else {
    lines.push("- (none active)");
  }
  lines.push("");

  lines.push("Locked Files:");
  if (state.lockedFiles.length) {
    for (const f of state.lockedFiles) {
      const age =
        f.confidence === "fresh"
          ? ""
          : ` ${confidenceBadge(f.confidence)} (${ageLabel(f.ageMs)})`;
      lines.push(`- ${f.path} (${f.owner})${age}`);
    }
  } else {
    lines.push("- (none)");
  }
  lines.push("");

  if (state.frameworks.length) {
    lines.push("Stack:", state.frameworks.join(", "), "");
  }

  lines.push("Next Recommended Steps:");
  nextSteps(state).forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  lines.push("");

  return (
    lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n"
  );
}

/**
 * Regenerate the derived files (`state.json`, `handoff.md`).
 *
 * Called automatically after every mutation. Safe to call when uninitialized —
 * it simply no-ops if there is no `.stated/` directory.
 */
export function regenerate(root: string): State {
  const state = buildState(root);
  const paths = statedPaths(root);
  ensureDir(paths.dir);
  writeJson(paths.state, state);
  writeText(paths.handoff, renderHandoff(state));
  return state;
}

/** Read the latest `handoff.md` text, regenerating it first for freshness. */
export function generateHandoff(root: string): string {
  return withProjectLock(root, () => {
    const state = regenerate(root);
    appendEvent(root, "handoff_generated");
    return renderHandoff(state);
  });
}

/**
 * Write a timestamped snapshot of all canonical files to
 * `.stated/snapshots/<timestamp>/`. Useful as a restore point before a risky
 * operation.
 */
export function createSnapshot(root: string): string {
  return withProjectLock(root, () => {
    const paths = statedPaths(root);
    const stamp = nowIso().replace(/[:.]/g, "-");
    const dir = join(paths.snapshots, stamp);
    ensureDir(dir);

    const state = regenerate(root);
    // Persist the materialized state plus a copy of the live task board so a
    // snapshot is fully self-describing.
    writeJson(join(dir, "state.json"), state);
    writeText(join(dir, "handoff.md"), renderHandoff(state));
    writeJson(join(dir, "tasks.json"), { tasks: readTasks(root) });

    appendEvent(root, "snapshot_created", { data: { dir: stamp } });
    return dir;
  });
}
