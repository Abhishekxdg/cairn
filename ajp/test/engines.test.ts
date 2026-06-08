import { describe, it, expect, afterAll } from "vitest";
import { memStore, cleanupAll } from "./helpers.js";
import { compileContext } from "../src/engines/context.js";
import { buildTimeline, renderTimeline } from "../src/engines/timeline.js";
import { deriveMemory, deriveKnowledge, deriveTimeline } from "../src/engines/memory.js";

afterAll(cleanupAll);

function seeded() {
  const s = memStore();
  s.appendEvent({ type: "agent.registered", payload: { name: "Claude Code" }, actor: "Claude Code" });
  s.appendEvent({ type: "goal.created", payload: { id: "g1", title: "Launch" } });
  s.appendEvent({ type: "task.created", payload: { id: "t1", title: "OAuth", priority: "high" } });
  s.appendEvent({ type: "task.started", payload: { id: "t1" }, actor: "Claude Code" });
  s.appendEvent({ type: "task.created", payload: { id: "t2", title: "Tests" } });
  s.appendEvent({ type: "decision.made", payload: { id: "d1", title: "Use SQLite", rationale: "WAL" } });
  return s;
}

describe("context compiler", () => {
  it("picks goal, current task, active decisions, next actions", () => {
    const ctx = compileContext(seeded(), { level: "small" });
    expect(ctx.goal).toBe("Launch");
    expect(ctx.currentTask?.id).toBe("t1");
    expect(ctx.activeDecisions[0]?.title).toBe("Use SQLite");
    expect(ctx.recommendedNextActions[0]).toContain("Finish");
    expect(ctx.activeAgents).toContain("Claude Code");
  });

  it("levels bound the number of items", () => {
    const s = memStore();
    for (let i = 0; i < 30; i++) s.appendEvent({ type: "task.created", payload: { id: `t${i}`, title: `T${i}` } });
    expect(compileContext(s, { level: "small" }).activeTasks.length).toBe(3);
    expect(compileContext(s, { level: "medium" }).activeTasks.length).toBe(8);
    expect(compileContext(s, { level: "full" }).activeTasks.length).toBe(30);
  });
});

describe("timeline", () => {
  it("groups by day and renders", () => {
    const s = memStore();
    s.appendEvent({ type: "decision.made", payload: { title: "Use PostgreSQL" }, timestamp: "2026-06-08T10:00:00.000Z" });
    s.appendEvent({ type: "task.started", payload: { id: "t1", title: "OAuth" }, timestamp: "2026-06-09T10:00:00.000Z" });
    const days = buildTimeline(s.streamEvents());
    expect(days.map((d) => d.date)).toEqual(["2026-06-08", "2026-06-09"]);
    const text = renderTimeline(days);
    expect(text).toContain("Use PostgreSQL");
    expect(text).toContain("2026-06-09");
  });

  it("deriveTimeline filters by type", () => {
    const s = seeded();
    const days = deriveTimeline(s, { types: ["decision.made"] });
    const all = days.flatMap((d) => d.entries);
    expect(all.every((e) => e.type === "decision.made")).toBe(true);
  });
});

describe("memory derivation", () => {
  it("derives memories and respects archive", () => {
    const s = memStore();
    s.appendEvent({ type: "memory.recorded", payload: { id: "m1", content: "User prefers tabs", tags: ["pref"] } });
    s.appendEvent({ type: "memory.recorded", payload: { id: "m2", content: "throwaway" } });
    s.appendEvent({ type: "memory.archived", payload: { id: "m2" } });
    const mems = deriveMemory(s);
    expect(mems).toHaveLength(1);
    expect(mems[0]?.content).toBe("User prefers tabs");
  });

  it("deriveKnowledge filters invalid by default", () => {
    const s = memStore();
    s.appendEvent({ type: "knowledge.learned", payload: { id: "k1", statement: "A" } });
    s.appendEvent({ type: "knowledge.learned", payload: { id: "k2", statement: "B" } });
    s.appendEvent({ type: "knowledge.invalidated", payload: { id: "k2" } });
    expect(deriveKnowledge(s)).toHaveLength(1);
    expect(deriveKnowledge(s, { includeInvalid: true })).toHaveLength(2);
  });
});
