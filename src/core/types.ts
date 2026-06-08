/**
 * Core type definitions for the Stated shared project state.
 *
 * Everything here maps 1:1 onto a file inside `.stated/`. The repository is the
 * source of truth — these types are simply the shape of what lives on disk.
 */

/** Lifecycle of a task. */
export type TaskStatus =
  | "todo"
  | "claimed"
  | "active"
  | "blocked"
  | "completed";

/** Priority of a task. */
export type TaskPriority = "low" | "medium" | "high" | "critical";

/** A unit of work tracked in `.stated/tasks.json`. */
export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  /** Agent or human name that owns the task, or empty string if unowned. */
  owner: string;
  priority: TaskPriority;
  /** ISO-8601 timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp. */
  updatedAt: string;
  /**
   * ISO-8601 timestamp of the last time this task was confirmed still true —
   * set on creation, refreshed on every mutation and on explicit `verify`.
   * Optional for backward compatibility; readers fall back to `updatedAt`.
   */
  lastVerifiedAt?: string;
  /**
   * Optional session/run scope this task belongs to. Lets one project carry
   * parallel work streams (e.g. a run per agent session) that can be filtered
   * independently. Unset means project-wide.
   */
  runId?: string;
}

/** Container shape of `.stated/tasks.json`. */
export interface TasksFile {
  tasks: Task[];
}

/** Kind of agent collaborating on the project. */
export type AgentType =
  | "claude"
  | "codex"
  | "cursor"
  | "openhands"
  | "human"
  | "other";

/** Liveness of an agent. */
export type AgentStatus = "active" | "idle" | "offline";

/** An agent registered in `.stated/agents.json`. */
export interface Agent {
  name: string;
  type: AgentType;
  status: AgentStatus;
  /** ISO-8601 timestamp of the last interaction. */
  lastSeen: string;
}

/** A file-ownership record in `.stated/files.json`. */
export interface FileOwnership {
  path: string;
  owner: string;
  locked: boolean;
  /** ISO-8601 timestamp of when the claim was made. */
  claimedAt: string;
  /**
   * ISO-8601 timestamp of the last time this claim was confirmed — refreshed on
   * (re)claim and explicit `verify`. Optional; readers fall back to `claimedAt`.
   */
  lastVerifiedAt?: string;
}

/**
 * Derived freshness of a decaying fact, computed from how long ago it was last
 * verified. Never stored on disk — always a function of the current time.
 */
export type Confidence = "fresh" | "aging" | "stale";

/** A decaying fact with its derived confidence + age, used in rendered state. */
export type TaskView = Task & { confidence: Confidence; ageMs: number };
export type FileView = FileOwnership & { confidence: Confidence; ageMs: number };

/** Aggregate freshness of the whole project, shown as a handoff banner. */
export interface Freshness {
  overall: Confidence;
  counts: { fresh: number; aging: number; stale: number };
  /** ISO-8601 timestamp of the most recent verification across decaying facts. */
  lastActivityAt: string | null;
}

/** A project decision. Canonical source is the `decision_added` event stream. */
export interface Decision {
  id: string;
  /** Calendar date (YYYY-MM-DD) the decision was made. */
  date: string;
  decision: string;
  reason: string;
  madeBy: string;
  /** ISO-8601 timestamp the decision was recorded. */
  createdAt: string;
  /** Optional session/run scope this decision belongs to. Unset = project-wide. */
  runId?: string;
}

/** Goals parsed from `.stated/goals.md`. */
export interface Goals {
  active: string[];
  completed: string[];
}

/** Project metadata parsed from `.stated/project.md`. */
export interface ProjectInfo {
  name: string;
  description: string;
  architecture: string;
  currentStatus: string;
}

/** Web/app framework Stated detected in the repo. */
export type Framework =
  | "Next.js"
  | "React"
  | "Vue"
  | "Angular"
  | "Express"
  | "Fastify"
  | "Laravel"
  | "Django"
  | "Flask";

/**
 * Machine-optimized compact project state, written to `.stated/state.json`.
 * Designed to be loaded by an agent in a single read for fast context priming.
 */
export interface State {
  /** Schema version of the state file. */
  version: number;
  /** Primary active goal (first active goal), or empty string. */
  goal: string;
  project: ProjectInfo;
  goals: Goals;
  /** Active tasks, each annotated with derived confidence + age. */
  activeTasks: TaskView[];
  recentDecisions: Decision[];
  activeAgents: Agent[];
  /** Locked files, each annotated with derived confidence + age. */
  lockedFiles: FileView[];
  frameworks: Framework[];
  /** Aggregate freshness of the project's decaying facts. */
  freshness: Freshness;
  /** ISO-8601 timestamp of the last snapshot regeneration. */
  generatedAt: string;
}

/** The discriminant for an append-only event in `.stated/events.jsonl`. */
export type EventType =
  | "initialized"
  | "agent_registered"
  | "agent_seen"
  | "goal_added"
  | "goal_completed"
  | "task_created"
  | "task_claimed"
  | "task_completed"
  | "task_updated"
  | "decision_added"
  | "file_claimed"
  | "file_released"
  | "memory_verified"
  | "memory_decayed"
  | "handoff_generated"
  | "snapshot_created";

/** Kind of document the keyword search ranks over. */
export type SearchType = "task" | "decision" | "goal";

/** A searchable unit built from a `.stated/` file (task, decision or goal). */
export interface SearchDoc {
  type: SearchType;
  /** Stable identifier (task/decision id, or a synthetic `goal-*` id). */
  id: string;
  /** Short label for display. */
  title: string;
  /** Full text the BM25 ranker scores against. */
  text: string;
  /** Type-specific display metadata (status, date, owner, …). */
  meta?: Record<string, unknown>;
}

/** A single ranked search result. */
export interface SearchHit {
  type: SearchType;
  id: string;
  title: string;
  /** BM25 relevance score, higher is better. */
  score: number;
  /** A short excerpt around the first query-term match. */
  snippet: string;
  meta: Record<string, unknown>;
}

/** A single append-only event record. */
export interface StatedEvent {
  type: EventType;
  /** ISO-8601 timestamp. */
  at: string;
  /** Actor (agent/human name) responsible, if known. */
  actor?: string;
  /** Arbitrary structured payload describing the event. */
  data?: Record<string, unknown>;
}
