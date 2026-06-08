import { describe, it, expect, afterAll } from "vitest";
import { fileStore, cleanupAll } from "./helpers.js";
import { deriveState } from "../src/engines/state.js";
import { createSnapshot } from "../src/engines/snapshots.js";
import { compactJournal } from "../src/engines/compaction.js";
import { validateIntegrity } from "../src/engines/observability.js";
import { pruneAgents, staleAgents } from "../src/engines/agents.js";

afterAll(cleanupAll);

describe("event-level compaction", () => {
  it("archives old events without losing them or breaking derivation", () => {
    const { store } = fileStore();
    for (let i = 0; i < 200; i++) {
      store.appendEvent({ type: "task.created", payload: { id: `t${i}`, title: `T${i}` } });
    }
    for (let i = 0; i < 100; i++) {
      store.appendEvent({ type: "task.completed", payload: { id: `t${i}` } });
    }
    const before = deriveState(store, { fromScratch: true, now: 0 });

    const report = compactJournal(store);
    expect(report.archived).toBeGreaterThan(0);
    expect(store.count()).toBeLessThan(300); // hot table shrank
    expect(store.archivedCount()).toBe(report.archived);
    expect(store.totalCount()).toBe(300); // nothing lost

    // Derivation is identical after compaction (snapshot+tail and full replay).
    const accelerated = deriveState(store, { now: 0 });
    const scratch = deriveState(store, { fromScratch: true, now: 0 });
    expect({ ...accelerated, generatedAt: "" }).toEqual({ ...before, generatedAt: "" });
    expect({ ...scratch, generatedAt: "" }).toEqual({ ...before, generatedAt: "" });
    store.close();
  });

  it("exportEvents returns the FULL history (hot + archive) in order", () => {
    const { store } = fileStore();
    for (let i = 0; i < 150; i++) store.appendEvent({ type: "custom.n", payload: { i } });
    compactJournal(store);
    expect(store.archivedCount()).toBeGreaterThan(0);
    const all = store.exportEvents();
    expect(all).toHaveLength(150);
    expect(all.map((e) => e.seq)).toEqual([...Array(150)].map((_, i) => i + 1));
    store.close();
  });

  it("keepRecent leaves the newest events hot", () => {
    const { store } = fileStore();
    for (let i = 0; i < 300; i++) store.appendEvent({ type: "custom.n", payload: { i } });
    createSnapshot(store, deriveState(store, { fromScratch: true }));
    compactJournal(store, { keepRecent: 50 });
    expect(store.count()).toBeGreaterThanOrEqual(50);
    store.close();
  });

  it("integrity holds across hot + archive after compaction", () => {
    const { store } = fileStore();
    for (let i = 0; i < 120; i++) store.appendEvent({ type: "custom.n", payload: { i } });
    compactJournal(store);
    const r = validateIntegrity(store);
    expect(r.healthy).toBe(true);
    expect(r.checked).toBe(120);
    store.close();
  });
});

describe("agent pruning", () => {
  it("detects and prunes stale agents via agent.disconnected", () => {
    const { store } = fileStore();
    const ts = "2026-06-08T00:00:00.000Z";
    store.appendEvent({ type: "agent.registered", payload: { name: "Claude Code" }, timestamp: ts });
    store.appendEvent({ type: "agent.registered", payload: { name: "Codex" }, timestamp: ts });
    const base = Date.parse(ts);
    const later = base + 2 * 60 * 60 * 1000; // 2h later

    expect(staleAgents(store, { now: later })).toHaveLength(2);
    const r = pruneAgents(store, { now: later });
    expect(r.pruned.sort()).toEqual(["Claude Code", "Codex"]);

    // After pruning they are offline and no longer stale-eligible.
    const st = deriveState(store, { now: later });
    expect(st.agents.every((a) => a.liveness === "offline")).toBe(true);
    expect(pruneAgents(store, { now: later }).pruned).toHaveLength(0); // idempotent
    store.close();
  });

  it("does not prune a recently-active agent", () => {
    const { store } = fileStore();
    store.appendEvent({ type: "agent.registered", payload: { name: "Claude Code" } });
    expect(pruneAgents(store).pruned).toHaveLength(0);
    store.close();
  });
});
