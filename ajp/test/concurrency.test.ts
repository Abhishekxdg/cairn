import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { EventStore } from "../src/core/store.js";
import { fileStore, tempDir, cleanupAll } from "./helpers.js";

afterAll(cleanupAll);

const here = dirname(fileURLToPath(import.meta.url));
const worker = join(here, "append-worker.mjs");

describe("concurrency", () => {
  it("in-process interleaved writers never lose updates", () => {
    const { store } = fileStore();
    // Simulate two writers interleaving on the same connection's engine locking.
    for (let i = 0; i < 500; i++) {
      store.appendEvent({ type: "custom.a", actor: "A", payload: { i } });
      store.appendEvent({ type: "custom.b", actor: "B", payload: { i } });
    }
    expect(store.count()).toBe(1000);
    // Gap-free, unique seq.
    const seqs = store.queryEvents().map((e) => e.seq);
    expect(seqs).toEqual([...Array(1000)].map((_, i) => i + 1));
    store.close();
  });

  it("multiple OS processes append concurrently with no lost updates", () => {
    const dir = tempDir();
    const dbPath = join(dir, "journal.db");
    // Initialize schema once before the workers race.
    const init = new EventStore(dbPath, { projectId: "concurrency" });
    init.close();

    const PROCS = 4;
    const PER = 250;
    // Launch all workers truly in parallel; each races to append PER events.
    const children = [];
    for (let p = 0; p < PROCS; p++) {
      children.push(
        new Promise<void>((resolve, reject) => {
          const child = spawn("node", [worker, dbPath, `agent-${p}`, String(PER)], {
            stdio: "ignore",
          });
          child.on("exit", (code) =>
            code === 0 ? resolve() : reject(new Error(`worker ${p} exited ${code}`)),
          );
          child.on("error", reject);
        }),
      );
    }
    return Promise.all(children).then(() => {
      const store = new EventStore(dbPath, {});
      expect(store.count()).toBe(PROCS * PER);
      // All seqs unique and gap-free → no lost updates, no corruption.
      const seqs = store.queryEvents().map((e) => e.seq);
      expect(new Set(seqs).size).toBe(PROCS * PER);
      expect(seqs[0]).toBe(1);
      expect(seqs[seqs.length - 1]).toBe(PROCS * PER);
      const integrity = store.db.pragma("integrity_check", { simple: true });
      expect(integrity).toBe("ok");
      store.close();
    });
  });
});
