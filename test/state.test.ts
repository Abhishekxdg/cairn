import { describe, it, expect, afterAll } from "vitest";
import { memStore, cleanupAll } from "./helpers.js";
import { deriveState, activeTasks, activeDecisions } from "../src/engines/state.js";
import { createSnapshot } from "../src/engines/snapshots.js";

afterAll(cleanupAll);

describe("state engine snapshot acceleration", () => {
  it("snapshot+tail equals full replay", () => {
    const s = memStore();
    for (let i = 0; i < 50; i++) {
      s.appendEvent({ type: "task.created", payload: { id: `t${i}`, title: `Task ${i}` } });
    }
    // Snapshot at seq 50.
    createSnapshot(s, deriveState(s, { fromScratch: true }));
    // More events after the snapshot.
    for (let i = 0; i < 25; i++) {
      s.appendEvent({ type: "task.completed", payload: { id: `t${i}` } });
    }
    const accelerated = deriveState(s, { now: 0 });
    const scratch = deriveState(s, { fromScratch: true, now: 0 });
    expect({ ...accelerated, generatedAt: "" }).toEqual({ ...scratch, generatedAt: "" });
    expect(accelerated.tasks.filter((t) => t.status === "completed")).toHaveLength(25);
  });

  it("derives at a historical seq", () => {
    const s = memStore();
    s.appendEvent({ type: "task.created", payload: { id: "t1", title: "A" } });
    s.appendEvent({ type: "task.completed", payload: { id: "t1" } });
    const atSeq1 = deriveState(s, { atSeq: 1, fromScratch: true });
    expect(atSeq1.tasks[0]?.status).toBe("todo");
    const now = deriveState(s);
    expect(now.tasks[0]?.status).toBe("completed");
  });

  it("selectors filter correctly", () => {
    const s = memStore();
    s.appendEvent({ type: "task.created", payload: { id: "t1", title: "A" } });
    s.appendEvent({ type: "task.created", payload: { id: "t2", title: "B" } });
    s.appendEvent({ type: "task.completed", payload: { id: "t2" } });
    s.appendEvent({ type: "decision.made", payload: { id: "d1", title: "X" } });
    const st = deriveState(s);
    expect(activeTasks(st)).toHaveLength(1);
    expect(activeDecisions(st)).toHaveLength(1);
  });
});
