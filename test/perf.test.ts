import { describe, it, expect, afterAll } from "vitest";
import { EventStore } from "../src/core/store.js";
import { fileStore, cleanupAll } from "./helpers.js";
import { deriveState } from "../src/engines/state.js";
import { compileContext } from "../src/engines/context.js";
import { buildTimeline } from "../src/engines/timeline.js";
import { createSnapshot } from "../src/engines/snapshots.js";

afterAll(cleanupAll);

/**
 * Performance regression guards. Bounds are deliberately generous (CI + the
 * parallel fork pool add jitter) — they catch order-of-magnitude regressions,
 * not exact targets. The tight figures (sub-ms append, sub-50ms context) come
 * from `npm run bench`, single-threaded at scale. Under coverage
 * (`CAIRN_COVERAGE=1`) v8 instrumentation inflates timings, so bounds scale ×8.
 */
const SLOW = process.env["CAIRN_COVERAGE"] ? 8 : 1;

describe("performance", () => {
  it("append latency is well under budget", () => {
    const { store } = fileStore();
    // Warm up.
    store.appendEvent({ type: "custom.warm" });
    const N = 2000;
    const start = process.hrtime.bigint();
    for (let i = 0; i < N; i++) store.appendEvent({ type: "custom.n", payload: { i } });
    const avgMs = Number(process.hrtime.bigint() - start) / 1e6 / N;
    expect(avgMs).toBeLessThan(25 * SLOW);
    store.close();
  });

  it("batchAppend handles many events fast", () => {
    const { store } = fileStore();
    const batch = [...Array(5000)].map((_, i) => ({ type: "custom.n", payload: { i } }));
    const start = process.hrtime.bigint();
    store.batchAppend(batch);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    expect(store.count()).toBe(5000);
    expect(ms).toBeLessThan(3000 * SLOW);
    store.close();
  });

  it("state derive + context + timeline stay within budget on a large journal", () => {
    const { store } = fileStore();
    // 10k events: a realistic medium journal.
    const batch = [];
    for (let i = 0; i < 10000; i++) {
      batch.push(
        i % 3 === 0
          ? { type: "task.created", payload: { id: `t${i}`, title: `Task ${i}` } }
          : { type: "file.modified", payload: { path: `src/f${i % 100}.ts` }, actor: "A" },
      );
    }
    store.batchAppend(batch);

    // Snapshot so derive uses the fast path.
    createSnapshot(store, deriveState(store, { fromScratch: true }));
    store.appendEvent({ type: "task.completed", payload: { id: "t0" } });

    let start = process.hrtime.bigint();
    const state = deriveState(store);
    const stateMs = Number(process.hrtime.bigint() - start) / 1e6;

    start = process.hrtime.bigint();
    compileContext(store, { level: "medium", state });
    const ctxMs = Number(process.hrtime.bigint() - start) / 1e6;

    start = process.hrtime.bigint();
    buildTimeline(store.queryEvents({ order: "desc", limit: 100 }));
    const tlMs = Number(process.hrtime.bigint() - start) / 1e6;

    expect(stateMs).toBeLessThan(250 * SLOW); // snapshot-accelerated
    expect(ctxMs).toBeLessThan(250 * SLOW);
    expect(tlMs).toBeLessThan(150 * SLOW);
    store.close();
  });

  it("streaming keeps memory flat over a large journal", () => {
    const { store } = fileStore();
    const batch = [...Array(50000)].map((_, i) => ({ type: "custom.n", payload: { i, blob: "x".repeat(50) } }));
    store.batchAppend(batch);

    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    let count = 0;
    // Consume via the paged generator WITHOUT materializing the array.
    for (const _ of store.streamEvents({ batchSize: 1000 })) count++;
    const deltaMb = (process.memoryUsage().heapUsed - before) / 1e6;

    expect(count).toBe(50000);
    // Paged streaming must not balloon heap by the full dataset size.
    expect(deltaMb).toBeLessThan(80 * SLOW);
    store.close();
  });

  it("cold start (open + first derive) is under budget", () => {
    const { store, dbPath } = fileStore();
    const batch = [...Array(20000)].map((_, i) => ({ type: "task.created", payload: { id: `t${i}`, title: `T${i}` } }));
    store.batchAppend(batch);
    createSnapshot(store, deriveState(store, { fromScratch: true }));
    store.close();

    // Fresh open simulates a cold process attaching to the journal.
    const start = process.hrtime.bigint();
    const reopened = new EventStore(dbPath, {});
    const state = deriveState(reopened);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    expect(state.tasks.length).toBe(20000);
    expect(ms).toBeLessThan(800 * SLOW);
    reopened.close();
  });
});
