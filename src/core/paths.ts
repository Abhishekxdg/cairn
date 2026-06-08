import { join, resolve } from "node:path";
import { existsSync } from "node:fs";

/** Name of the directory that holds all Stated project state. */
export const STATED_DIR = ".stated";

/** Relative file names inside `.stated/`. */
export const FILE = {
  project: "project.md",
  goals: "goals.md",
  tasks: "tasks.json",
  decisions: "decisions.md",
  agents: "agents.json",
  files: "files.json",
  handoff: "handoff.md",
  state: "state.json",
  events: "events.jsonl",
  config: "config.json",
  snapshots: "snapshots",
} as const;

/** Resolved absolute paths for a given project root. */
export interface StatedPaths {
  /** The project root (directory that contains `.stated/`). */
  root: string;
  /** The `.stated/` directory itself. */
  dir: string;
  project: string;
  goals: string;
  tasks: string;
  decisions: string;
  agents: string;
  files: string;
  handoff: string;
  state: string;
  events: string;
  config: string;
  snapshots: string;
}

/** Build the set of absolute paths for a project root. */
export function statedPaths(root: string): StatedPaths {
  const r = resolve(root);
  const dir = join(r, STATED_DIR);
  return {
    root: r,
    dir,
    project: join(dir, FILE.project),
    goals: join(dir, FILE.goals),
    tasks: join(dir, FILE.tasks),
    decisions: join(dir, FILE.decisions),
    agents: join(dir, FILE.agents),
    files: join(dir, FILE.files),
    handoff: join(dir, FILE.handoff),
    state: join(dir, FILE.state),
    events: join(dir, FILE.events),
    config: join(dir, FILE.config),
    snapshots: join(dir, FILE.snapshots),
  };
}

/**
 * Walk upward from `start` looking for a directory that contains `.stated/`.
 * Returns the project root, or `null` if none is found before the filesystem
 * root. This lets the CLI be invoked from any subdirectory of the project.
 */
export function findProjectRoot(start: string = process.cwd()): string | null {
  let current = resolve(start);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (existsSync(join(current, STATED_DIR))) return current;
    const parent = resolve(current, "..");
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Resolve the project root, throwing a friendly error when Stated has not been
 * initialized anywhere up the tree.
 */
export function requireProjectRoot(start: string = process.cwd()): string {
  const root = findProjectRoot(start);
  if (!root) {
    throw new Error(
      "No .stated/ directory found. Run `stated init` in your project root first.",
    );
  }
  return root;
}

/** Whether a project has been initialized at (or above) `start`. */
export function isInitialized(start: string = process.cwd()): boolean {
  return findProjectRoot(start) !== null;
}
