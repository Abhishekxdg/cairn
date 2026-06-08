import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Manifest } from "./types.js";
import { agentPaths, LAYOUT } from "./paths.js";
import { EventStore } from "./store.js";
import { SCHEMA_VERSION } from "./schema.js";
import { shortId, nowIso } from "./ids.js";

/**
 * Initialization + manifest handling.
 *
 * `ajp init` creates the `.agent/` directory, writes a manifest, opens the
 * SQLite journal (running migrations), and stamps the project id. The on-disk
 * layout exists for portability; the database powers performance.
 */

export interface InitOptions {
  name?: string;
  projectId?: string;
  force?: boolean;
}

export interface InitResult {
  root: string;
  projectId: string;
  created: boolean;
}

const GITIGNORE = `# Derived/optimization data — rebuildable from the journal, not committed.
journal.db-wal
journal.db-shm
state/
snapshots/
indexes/
locks/
`;

/** Initialize a `.agent/` journal at `root`. */
export function init(root: string, options: InitOptions = {}): InitResult {
  const paths = agentPaths(root);
  if (existsSync(paths.manifest) && !options.force) {
    throw new Error(
      `${paths.dir} already initialized. Pass force to reinitialize the scaffolding.`,
    );
  }

  for (const sub of [
    LAYOUT.snapshots,
    LAYOUT.artifacts,
    LAYOUT.indexes,
    LAYOUT.locks,
    LAYOUT.state,
    LAYOUT.schemas,
    LAYOUT.events,
  ]) {
    mkdirSync(join(paths.dir, sub), { recursive: true });
  }

  const projectId = options.projectId ?? shortId("proj");
  const manifest: Manifest = {
    protocol: "agent-journal-protocol",
    schemaVersion: SCHEMA_VERSION,
    projectId,
    name: options.name ?? basename(root),
    createdAt: nowIso(),
  };
  writeFileSync(paths.manifest, JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(paths.dir, ".gitignore"), GITIGNORE);

  // Open the store (creates + migrates the db) and persist the project id.
  const store = new EventStore(paths.db, { projectId });
  store.setMeta("project_id", projectId);
  store.setMeta("name", manifest.name);
  store.appendEvent({
    type: "session.started",
    actor: "ajp",
    payload: { reason: "journal initialized", name: manifest.name },
  });
  store.close();

  return { root: paths.root, projectId, created: true };
}

/** Read the manifest for a project root. */
export function readManifest(root: string): Manifest {
  const paths = agentPaths(root);
  return JSON.parse(readFileSync(paths.manifest, "utf8")) as Manifest;
}

function basename(p: string): string {
  const parts = p.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || "project";
}
