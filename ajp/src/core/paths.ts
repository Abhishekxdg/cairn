import { join, resolve } from "node:path";
import { existsSync } from "node:fs";

/** The directory that holds the journal — the `.git` of cognition. */
export const AGENT_DIR = ".agent";

/** Layout of the `.agent/` directory. */
export const LAYOUT = {
  manifest: "manifest.json",
  db: "journal.db",
  events: "events", // jsonl export mirror (portability)
  snapshots: "snapshots",
  artifacts: "artifacts",
  indexes: "indexes",
  locks: "locks",
  state: "state",
  schemas: "schemas",
} as const;

/** Resolved absolute paths for a project's `.agent/` directory. */
export interface AgentPaths {
  root: string;
  dir: string;
  manifest: string;
  db: string;
  events: string;
  snapshots: string;
  artifacts: string;
  indexes: string;
  locks: string;
  state: string;
  schemas: string;
}

/** Build absolute `.agent/` paths for a project root. */
export function agentPaths(root: string): AgentPaths {
  const r = resolve(root);
  const dir = join(r, AGENT_DIR);
  return {
    root: r,
    dir,
    manifest: join(dir, LAYOUT.manifest),
    db: join(dir, LAYOUT.db),
    events: join(dir, LAYOUT.events),
    snapshots: join(dir, LAYOUT.snapshots),
    artifacts: join(dir, LAYOUT.artifacts),
    indexes: join(dir, LAYOUT.indexes),
    locks: join(dir, LAYOUT.locks),
    state: join(dir, LAYOUT.state),
    schemas: join(dir, LAYOUT.schemas),
  };
}

/** Walk up from `start` to find a directory containing `.agent/`. */
export function findRoot(start: string = process.cwd()): string | null {
  let current = resolve(start);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (existsSync(join(current, AGENT_DIR))) return current;
    const parent = resolve(current, "..");
    if (parent === current) return null;
    current = parent;
  }
}

/** Resolve the project root or throw a friendly error. */
export function requireRoot(start: string = process.cwd()): string {
  const root = findRoot(start);
  if (!root) {
    throw new Error("No .agent/ journal found. Run `ajp init` first.");
  }
  return root;
}

/** Whether a journal exists at or above `start`. */
export function isInitialized(start: string = process.cwd()): boolean {
  return findRoot(start) !== null;
}
