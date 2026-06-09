import { describe, it, expect, afterAll } from "vitest";
import { memStore, cleanupAll } from "./helpers.js";
import { deriveState, activeTasks, activeDecisions, anchors } from "../src/engines/state.js";
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

  it("anchors survive the snapshot+tail fast path identically to full replay", () => {
    const s = memStore();
    s.appendEvent({ type: "decision.made", payload: { id: "d1", title: "PKCE", anchor: true } });
    s.appendEvent({ type: "knowledge.learned", payload: { id: "k1", statement: "allowlist URIs", anchor: true } });
    // Snapshot caches the anchor flag; the tail must not lose it on rehydrate.
    createSnapshot(s, deriveState(s, { fromScratch: true }));
    s.appendEvent({ type: "knowledge.learned", payload: { id: "k2", statement: "post-snapshot fact", anchor: true } });

    const accelerated = anchors(deriveState(s)); // snapshot + tail
    const scratch = anchors(deriveState(s, { fromScratch: true })); // full replay
    expect(accelerated).toEqual(scratch); // fast path == full replay (the real invariant)
    // All three anchors survive (order is weight/recency-ranked, so compare as a set).
    expect(accelerated.map((a) => a.id).sort()).toEqual(["d1", "k1", "k2"]);
  });
});
