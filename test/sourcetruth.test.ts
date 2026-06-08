import { describe, it, expect, afterAll } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tempDir, cleanupAll } from "./helpers.js";
import { EventStore } from "../src/core/store.js";

afterAll(cleanupAll);

function paths(dir: string) {
  return { db: join(dir, "journal.db"), jsonl: join(dir, "events.jsonl") };
}

describe("events.jsonl as the committed source of truth", () => {
  it("mirrors every append to events.jsonl", () => {
    const dir = tempDir();
    const { jsonl } = paths(dir);
    const s = new EventStore(join(dir, "journal.db"), { projectId: "t" });
    s.appendEvent({ type: "goal.created", payload: { id: "g1", title: "X" } });
    s.appendEvent({ type: "decision.made", payload: { id: "d1", title: "Use SQLite" } });
    s.close();

    expect(existsSync(jsonl)).toBe(true);
    const lines = readFileSync(jsonl, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!).payload.title).toBe("Use SQLite");
  });

  it("rebuilds the db cache from events.jsonl when the db is gone (fresh clone)", () => {
    const dir = tempDir();
    const { db } = paths(dir);
    let s = new EventStore(db, { projectId: "t" });
    for (let i = 0; i < 5; i++) s.appendEvent({ type: "custom.n", payload: { i } });
    const before = s.exportEvents().map((e) => `${e.seq}:${e.id}`);
    s.close();

    // Simulate a fresh clone: db (+ wal/shm) gone, only events.jsonl committed.
    for (const f of ["journal.db", "journal.db-wal", "journal.db-shm"]) {
      rmSync(join(dir, f), { force: true });
    }
    expect(existsSync(db)).toBe(false);

    s = new EventStore(db, { projectId: "t" });
    expect(s.count()).toBe(5);
    // seq + id preserved exactly (deterministic rebuild).
    expect(s.exportEvents().map((e) => `${e.seq}:${e.id}`)).toEqual(before);
    s.close();
  });

  it("materializes events.jsonl for a legacy db that has none", () => {
    const dir = tempDir();
    const { db, jsonl } = paths(dir);
    // First store writes both.
    const s1 = new EventStore(db, { projectId: "t" });
    s1.appendEvent({ type: "custom.a" });
    s1.appendEvent({ type: "custom.b" });
    s1.close();
    // Delete only the jsonl to mimic a pre-jsonl (legacy) journal.
    rmSync(jsonl, { force: true });
    expect(existsSync(jsonl)).toBe(false);

    const s2 = new EventStore(db, { projectId: "t" });
    expect(existsSync(jsonl)).toBe(true); // re-materialized on open
    expect(readFileSync(jsonl, "utf8").trim().split("\n")).toHaveLength(2);
    s2.close();
  });

  it("stays in sync (no-op) on a normal reopen", () => {
    const dir = tempDir();
    const { db, jsonl } = paths(dir);
    const s1 = new EventStore(db, { projectId: "t" });
    s1.appendEvent({ type: "custom.a" });
    s1.close();
    const before = readFileSync(jsonl, "utf8");
    const s2 = new EventStore(db, { projectId: "t" });
    expect(s2.count()).toBe(1);
    s2.close();
    expect(readFileSync(jsonl, "utf8")).toBe(before); // not rewritten
  });
});
