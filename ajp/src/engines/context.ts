import type { EventStore } from "../core/store.js";
import type { DerivedState, Task } from "../core/types.js";
import { deriveState, activeTasks, activeDecisions, activeGoals } from "./state.js";
import { timelineEntries, type TimelineEntry } from "./timeline.js";

/**
 * Context compiler — the flagship.
 *
 * Turns a journal of (potentially millions of) events into the smallest useful
 * block of context an agent needs to act correctly. Four levels trade tokens for
 * completeness. The output is intentionally compact and structured so a model
 * can consume it in one read.
 */

export type ContextLevel = "small" | "medium" | "large" | "full";

export interface CompiledContext {
  level: ContextLevel;
  projectId: string;
  goal: string;
  currentTask: { id: string; title: string; status: string; owner: string } | null;
  activeTasks: Array<{ id: string; title: string; status: string; owner: string; priority: string }>;
  activeDecisions: Array<{ id: string; title: string; rationale: string }>;
  recentActivity: Array<{ at: string; actor: string; summary: string }>;
  activeAgents: string[];
  recommendedNextActions: string[];
  /** Sequence the context was compiled at. */
  asOfSeq: number;
  generatedAt: string;
}

const LIMITS: Record<
  ContextLevel,
  { tasks: number; decisions: number; activity: number }
> = {
  small: { tasks: 3, decisions: 3, activity: 5 },
  medium: { tasks: 8, decisions: 6, activity: 12 },
  large: { tasks: 20, decisions: 15, activity: 30 },
  full: { tasks: Infinity, decisions: Infinity, activity: 100 },
};

const PRIORITY_RANK: Record<Task["priority"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};
const STATUS_RANK: Record<string, number> = {
  active: 0,
  blocked: 1,
  todo: 2,
  completed: 3,
  archived: 4,
};

function rankTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    if (STATUS_RANK[a.status]! !== STATUS_RANK[b.status]!) {
      return STATUS_RANK[a.status]! - STATUS_RANK[b.status]!;
    }
    if (PRIORITY_RANK[a.priority] !== PRIORITY_RANK[b.priority]) {
      return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    }
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

/** Heuristic next actions from the current task board — no model involved. */
function nextActions(state: DerivedState): string[] {
  const out: string[] = [];
  const tasks = state.tasks;
  for (const t of tasks.filter((t) => t.status === "blocked")) {
    out.push(`Unblock "${t.title}" (${t.id})${t.blockers.length ? `: ${t.blockers.join(", ")}` : ""}`);
  }
  for (const t of tasks.filter((t) => t.status === "active")) {
    out.push(`Finish "${t.title}" (${t.id})`);
  }
  for (const t of rankTasks(tasks.filter((t) => t.status === "todo")).slice(0, 3)) {
    out.push(`Start "${t.title}" (${t.id})`);
  }
  if (out.length === 0) {
    const goal = activeGoals(state)[0];
    out.push(
      goal
        ? `Break the goal "${goal.title}" into tasks`
        : "Define a goal and create the first task",
    );
  }
  return out.slice(0, 7);
}

/** Compile context at a given level. */
export function compileContext(
  store: EventStore,
  opts: { level?: ContextLevel; state?: DerivedState; now?: number } = {},
): CompiledContext {
  const level = opts.level ?? "medium";
  const limit = LIMITS[level];
  const state = opts.state ?? deriveState(store, opts.now ? { now: opts.now } : {});

  const ranked = rankTasks(activeTasks(state));
  const current = ranked.find((t) => t.status === "active") ?? ranked[0] ?? null;

  // Recent activity from the tail of the journal (newest first → oldest).
  const recentEvents = store.queryEvents({
    order: "desc",
    limit: Number.isFinite(limit.activity) ? limit.activity : 100,
  });
  const recent: TimelineEntry[] = timelineEntries(recentEvents);

  const goal = activeGoals(state)[0]?.title ?? "";

  return {
    level,
    projectId: state.projectId,
    goal,
    currentTask: current
      ? { id: current.id, title: current.title, status: current.status, owner: current.owner }
      : null,
    activeTasks: ranked
      .slice(0, Number.isFinite(limit.tasks) ? limit.tasks : ranked.length)
      .map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        owner: t.owner,
        priority: t.priority,
      })),
    activeDecisions: activeDecisions(state)
      .slice(0, Number.isFinite(limit.decisions) ? limit.decisions : undefined)
      .map((d) => ({ id: d.id, title: d.title, rationale: d.rationale })),
    recentActivity: recent.map((e) => ({
      at: e.timestamp,
      actor: e.actor,
      summary: e.summary,
    })),
    activeAgents: state.agents
      .filter((a) => a.liveness === "active")
      .map((a) => a.name),
    recommendedNextActions: nextActions(state),
    asOfSeq: state.lastSeq,
    generatedAt: state.generatedAt,
  };
}
