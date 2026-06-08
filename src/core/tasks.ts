import type { Task, TasksFile, TaskPriority, TaskStatus } from "./types.js";
import { readJson, writeJson } from "./io.js";
import { statedPaths } from "./paths.js";
import { taskId, nowIso } from "./ids.js";
import { appendEvent } from "./events.js";
import { regenerate } from "./snapshot.js";

const ACTIVE_STATUSES: TaskStatus[] = ["todo", "claimed", "active", "blocked"];

/** Read all tasks from `.stated/tasks.json`. */
export function readTasks(root: string): Task[] {
  return readJson<TasksFile>(statedPaths(root).tasks, { tasks: [] }).tasks;
}

/** Overwrite the full task list. */
export function writeTasks(root: string, tasks: Task[]): void {
  writeJson(statedPaths(root).tasks, { tasks });
}

/** Find a single task by id, or `undefined`. */
export function getTask(root: string, id: string): Task | undefined {
  return readTasks(root).find((t) => t.id === id);
}

/** Tasks that are not yet completed. */
export function activeTasks(root: string): Task[] {
  return readTasks(root).filter((t) => ACTIVE_STATUSES.includes(t.status));
}

export interface AddTaskInput {
  title: string;
  description?: string;
  priority?: TaskPriority;
  owner?: string;
  status?: TaskStatus;
  /** Optional session/run scope for this task. */
  runId?: string;
}

/** Tasks belonging to a given run/session scope. */
export function tasksInRun(root: string, runId: string): Task[] {
  return readTasks(root).filter((t) => t.runId === runId);
}

/** Create a new task, append an event, and regenerate the snapshot. */
export function addTask(
  root: string,
  input: AddTaskInput,
  actor?: string,
): Task {
  const title = input.title.trim();
  if (!title) throw new Error("Task title cannot be empty.");
  const now = nowIso();
  const task: Task = {
    id: taskId(),
    title,
    description: input.description?.trim() ?? "",
    status: input.status ?? "todo",
    owner: input.owner?.trim() ?? "",
    priority: input.priority ?? "medium",
    createdAt: now,
    updatedAt: now,
    lastVerifiedAt: now,
    ...(input.runId?.trim() ? { runId: input.runId.trim() } : {}),
  };
  const tasks = readTasks(root);
  tasks.push(task);
  writeTasks(root, tasks);
  appendEvent(root, "task_created", {
    ...(actor ? { actor } : {}),
    data: { id: task.id, title: task.title, priority: task.priority },
  });
  regenerate(root);
  return task;
}

function mutate(root: string, id: string, fn: (t: Task) => void): Task {
  const tasks = readTasks(root);
  const task = tasks.find((t) => t.id === id);
  if (!task) throw new Error(`No task with id "${id}".`);
  fn(task);
  const now = nowIso();
  task.updatedAt = now;
  // Touching a task is an implicit confirmation that it is still true.
  task.lastVerifiedAt = now;
  writeTasks(root, tasks);
  return task;
}

/**
 * Re-confirm a task is still accurate without changing its content. Refreshes
 * `lastVerifiedAt` so the staleness clock resets. This is how an agent says
 * "I checked — this is still current" with zero side effects.
 */
export function verifyTask(root: string, id: string, actor?: string): Task {
  const tasks = readTasks(root);
  const task = tasks.find((t) => t.id === id);
  if (!task) throw new Error(`No task with id "${id}".`);
  task.lastVerifiedAt = nowIso();
  writeTasks(root, tasks);
  appendEvent(root, "memory_verified", {
    ...(actor ? { actor } : {}),
    data: { kind: "task", id },
  });
  regenerate(root);
  return task;
}

/**
 * Claim a task for an owner. Refuses to steal a task already owned by a
 * different active agent unless `force` is set.
 */
export function claimTask(
  root: string,
  id: string,
  owner: string,
  opts: { force?: boolean } = {},
): Task {
  const o = owner.trim();
  if (!o) throw new Error("Claiming a task requires an owner.");
  const existing = getTask(root, id);
  if (!existing) throw new Error(`No task with id "${id}".`);
  if (
    !opts.force &&
    existing.owner &&
    existing.owner !== o &&
    existing.status !== "completed"
  ) {
    throw new Error(
      `Task ${id} is already owned by "${existing.owner}". ` +
        "Pass force to override.",
    );
  }
  const task = mutate(root, id, (t) => {
    t.owner = o;
    t.status = "claimed";
  });
  appendEvent(root, "task_claimed", { actor: o, data: { id, owner: o } });
  regenerate(root);
  return task;
}

/** Move a task to `active`. */
export function startTask(root: string, id: string, actor?: string): Task {
  const task = mutate(root, id, (t) => {
    t.status = "active";
    if (actor && !t.owner) t.owner = actor;
  });
  appendEvent(root, "task_updated", {
    ...(actor ? { actor } : {}),
    data: { id, status: "active" },
  });
  regenerate(root);
  return task;
}

/** Complete a task, append an event, and regenerate the snapshot. */
export function completeTask(root: string, id: string, actor?: string): Task {
  const task = mutate(root, id, (t) => {
    t.status = "completed";
  });
  appendEvent(root, "task_completed", {
    ...(actor ? { actor } : {}),
    data: { id, title: task.title },
  });
  regenerate(root);
  return task;
}

/** Block a task with an optional reason. */
export function blockTask(
  root: string,
  id: string,
  reason?: string,
  actor?: string,
): Task {
  const task = mutate(root, id, (t) => {
    t.status = "blocked";
  });
  appendEvent(root, "task_updated", {
    ...(actor ? { actor } : {}),
    data: { id, status: "blocked", ...(reason ? { reason } : {}) },
  });
  regenerate(root);
  return task;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  priority?: TaskPriority;
  status?: TaskStatus;
  owner?: string;
}

/** Apply a partial update to a task. */
export function updateTask(
  root: string,
  id: string,
  patch: UpdateTaskInput,
  actor?: string,
): Task {
  const task = mutate(root, id, (t) => {
    if (patch.title !== undefined) t.title = patch.title.trim();
    if (patch.description !== undefined) t.description = patch.description.trim();
    if (patch.priority !== undefined) t.priority = patch.priority;
    if (patch.status !== undefined) t.status = patch.status;
    if (patch.owner !== undefined) t.owner = patch.owner.trim();
  });
  appendEvent(root, "task_updated", {
    ...(actor ? { actor } : {}),
    data: { id, ...patch },
  });
  regenerate(root);
  return task;
}
