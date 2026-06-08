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
  activeTasks: Task[];
  recentDecisions: Decision[];
  activeAgents: Agent[];
  lockedFiles: FileOwnership[];
  frameworks: Framework[];
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
  | "handoff_generated"
  | "snapshot_created";

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
