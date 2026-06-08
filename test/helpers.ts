import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../src/core/store.js";

const created: string[] = [];

/** A fresh temp directory. */
export function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "cairn-test-"));
  created.push(d);
  return d;
}

/** A file-backed store in a fresh temp dir (for WAL/concurrency/crash tests). */
export function fileStore(projectId = "test"): { store: EventStore; dir: string; dbPath: string } {
  const dir = tempDir();
  const dbPath = join(dir, "journal.db");
  return { store: new EventStore(dbPath, { projectId }), dir, dbPath };
}

/** An in-memory store (fast unit tests). */
export function memStore(projectId = "test"): EventStore {
  return new EventStore(":memory:", { projectId });
}

/** Remove all temp dirs created during the test run. */
export function cleanupAll(): void {
  for (const d of created) rmSync(d, { recursive: true, force: true });
  created.length = 0;
}
