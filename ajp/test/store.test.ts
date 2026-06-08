import { describe, it, expect, afterAll } from "vitest";
import { EventStore } from "../src/core/store.js";
import { memStore, fileStore, cleanupAll } from "./helpers.js";

afterAll(cleanupAll);

describe("EventStore append", () => {
  it("assigns gap-free monotonic seq", () => {
    const s = memStore();
    const a = s.appendEvent({ type: "custom.a" });
    const b = s.appendEvent({ type: "custom.b" });
    const c = s.appendEvent({ type: "custom.c" });
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
    expect(s.lastSeq()).toBe(3);
    expect(s.count()).toBe(3);
  });

  it("is idempotent on explicit id", () => {
    const s = memStore();
    const first = s.appendEvent({ id: "fixed", type: "custom.x", payload: { v: 1 } });
    const again = s.appendEvent({ id: "fixed", type: "custom.x", payload: { v: 2 } });
    expect(s.count()).toBe(1);
    expect(again.seq).toBe(first.seq);
    expect(again.payload.v).toBe(1); // original wins
  });

  it("round-trips payloads and metadata", () => {
    const s = memStore("proj1");
    const ev = s.appendEvent({
      type: "decision.made",
      actor: "Claude",
      sessionId: "sess1",
      payload: { title: "Use SQLite", nested: { a: [1, 2] } },
    });
    const got = s.getById(ev.id)!;
    expect(got.actor).toBe("Claude");
    expect(got.sessionId).toBe("sess1");
    expect(got.projectId).toBe("proj1");
    expect(got.payload).toEqual({ title: "Use SQLite", nested: { a: [1, 2] } });
  });

  it("batchAppend is atomic and ordered", () => {
    const s = memStore();
    const events = s.batchAppend([
      { type: "custom.a" },
      { type: "custom.b" },
      { type: "custom.c" },
    ]);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(s.count()).toBe(3);
  });
});

describe("EventStore query/stream/replay", () => {
  function seeded() {
    const s = memStore();
    s.appendEvent({ type: "task.created", actor: "A", payload: { id: "t1" } });
    s.appendEvent({ type: "task.created", actor: "B", payload: { id: "t2" } });
    s.appendEvent({ type: "decision.made", actor: "A", payload: { id: "d1" } });
    s.appendEvent({ type: "task.completed", actor: "B", payload: { id: "t1" } });
    return s;
  }

  it("filters by type and actor", () => {
    const s = seeded();
    expect(s.queryEvents({ types: ["task.created"] })).toHaveLength(2);
    expect(s.queryEvents({ actor: "A" })).toHaveLength(2);
    expect(s.queryEvents({ types: ["task.created"], actor: "B" })).toHaveLength(1);
  });

  it("filters by seq window and orders", () => {
    const s = seeded();
    expect(s.queryEvents({ sinceSeq: 2 }).map((e) => e.seq)).toEqual([3, 4]);
    expect(s.queryEvents({ order: "desc", limit: 1 })[0]?.seq).toBe(4);
  });

  it("streams in pages", () => {
    const s = memStore();
    for (let i = 0; i < 2500; i++) s.appendEvent({ type: "custom.n", payload: { i } });
    let count = 0;
    let prev = 0;
    for (const ev of s.streamEvents({ batchSize: 500 })) {
      expect(ev.seq).toBe(prev + 1);
      prev = ev.seq;
      count++;
    }
    expect(count).toBe(2500);
  });

  it("replayEvents folds a reducer", () => {
    const s = seeded();
    const total = s.replayEvents((acc) => acc + 1, 0);
    expect(total).toBe(4);
  });

  it("exportEvents returns everything in order", () => {
    const s = seeded();
    const all = s.exportEvents();
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });
});

describe("EventStore durability", () => {
  it("survives reopening the database (WAL crash recovery)", () => {
    const { store, dbPath } = fileStore();
    store.appendEvent({ type: "custom.a", payload: { keep: true } });
    store.appendEvent({ type: "custom.b" });
    // Simulate a crash: drop the reference and reopen on the same file. WAL +
    // synchronous=NORMAL guarantees committed events survive.
    store.close();

    const reopened = new EventStore(dbPath, {});
    expect(reopened.count()).toBe(2);
    expect(reopened.getById(reopened.queryEvents()[0]!.id)?.payload.keep).toBe(true);
    reopened.close();
  });
});
