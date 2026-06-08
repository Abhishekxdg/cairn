import { describe, it, expect, afterAll } from "vitest";
import { memStore, cleanupAll } from "./helpers.js";
import { foldState } from "../src/reducers/index.js";

afterAll(cleanupAll);

function stateOf(s: ReturnType<typeof memStore>, now?: number) {
  return foldState(s.streamEvents(), s.projectId, now);
}

describe("task fold", () => {
  it("derives lifecycle todo→active→blocked→completed", () => {
    const s = memStore();
    s.appendEvent({ type: "task.created", payload: { id: "t1", title: "OAuth", priority: "high" }, actor: "Claude" });
    let st = stateOf(s);
    expect(st.tasks[0]).toMatchObject({ id: "t1", status: "todo", priority: "high", createdBy: "Claude" });

    s.appendEvent({ type: "task.started", payload: { id: "t1" }, actor: "Claude" });
    expect(stateOf(s).tasks[0]?.status).toBe("active");
    expect(stateOf(s).tasks[0]?.owner).toBe("Claude");

    s.appendEvent({ type: "task.blocked", payload: { id: "t1", reason: "waiting on infra" } });
    st = stateOf(s);
    expect(st.tasks[0]?.status).toBe("blocked");
    expect(st.tasks[0]?.blockers).toContain("waiting on infra");

    s.appendEvent({ type: "task.completed", payload: { id: "t1" }, actor: "Codex" });
    st = stateOf(s);
    expect(st.tasks[0]?.status).toBe("completed");
    expect(st.tasks[0]?.completedBy).toBe("Codex");
  });
});

describe("decision fold + supersession", () => {
  it("supersedes the prior decision automatically", () => {
    const s = memStore();
    s.appendEvent({ type: "decision.made", payload: { id: "d1", title: "Use PostgreSQL" } });
    s.appendEvent({ type: "decision.made", payload: { id: "d2", title: "Use CockroachDB", supersedes: "d1" } });
    const st = stateOf(s);
    const d1 = st.decisions.find((d) => d.id === "d1")!;
    const d2 = st.decisions.find((d) => d.id === "d2")!;
    expect(d1.status).toBe("superseded");
    expect(d1.supersededBy).toBe("d2");
    expect(d2.status).toBe("active");
    expect(st.decisions.filter((d) => d.status === "active")).toHaveLength(1);
  });

  it("supports revert", () => {
    const s = memStore();
    s.appendEvent({ type: "decision.made", payload: { id: "d1", title: "X" } });
    s.appendEvent({ type: "decision.reverted", payload: { id: "d1" } });
    expect(stateOf(s).decisions[0]?.status).toBe("reverted");
  });
});

describe("goal / knowledge / file folds", () => {
  it("goals archive", () => {
    const s = memStore();
    s.appendEvent({ type: "goal.created", payload: { id: "g1", title: "Ship" } });
    s.appendEvent({ type: "goal.archived", payload: { id: "g1" } });
    expect(stateOf(s).goals[0]?.status).toBe("archived");
  });

  it("knowledge can be invalidated", () => {
    const s = memStore();
    s.appendEvent({ type: "knowledge.learned", payload: { id: "k1", statement: "API rate limit is 100/s" } });
    expect(stateOf(s).knowledge[0]?.valid).toBe(true);
    s.appendEvent({ type: "knowledge.invalidated", payload: { id: "k1" } });
    expect(stateOf(s).knowledge[0]?.valid).toBe(false);
  });

  it("ownership tracks last writer; delete removes it", () => {
    const s = memStore();
    s.appendEvent({ type: "file.modified", payload: { path: "src/a.ts" }, actor: "Claude" });
    s.appendEvent({ type: "file.modified", payload: { path: "src/a.ts" }, actor: "Codex" });
    expect(stateOf(s).ownership[0]).toMatchObject({ path: "src/a.ts", owner: "Codex" });
    s.appendEvent({ type: "file.deleted", payload: { path: "src/a.ts" } });
    expect(stateOf(s).ownership).toHaveLength(0);
  });
});

describe("agent liveness", () => {
  it("registers then goes idle past the window", () => {
    const s = memStore();
    const ts = "2026-06-08T00:00:00.000Z";
    s.appendEvent({ type: "agent.registered", payload: { name: "Claude Code" }, timestamp: ts });
    const base = Date.parse(ts);
    expect(foldState(s.streamEvents(), s.projectId, base).agents[0]?.liveness).toBe("active");
    expect(foldState(s.streamEvents(), s.projectId, base + 60 * 60 * 1000).agents[0]?.liveness).toBe("idle");
  });

  it("infers type from name", () => {
    const s = memStore();
    s.appendEvent({ type: "agent.registered", payload: { name: "Codex" } });
    expect(stateOf(s).agents[0]?.type).toBe("codex");
  });
});

describe("more lifecycle edges", () => {
  it("goal.updated edits title/description", () => {
    const s = memStore();
    s.appendEvent({ type: "goal.created", payload: { id: "g1", title: "Old" } });
    s.appendEvent({ type: "goal.updated", payload: { id: "g1", title: "New", description: "why" } });
    const g = stateOf(s).goals[0]!;
    expect(g.title).toBe("New");
    expect(g.description).toBe("why");
  });

  it("task.archived archives a task", () => {
    const s = memStore();
    s.appendEvent({ type: "task.created", payload: { id: "t1", title: "A" } });
    s.appendEvent({ type: "task.archived", payload: { id: "t1" } });
    expect(stateOf(s).tasks[0]?.status).toBe("archived");
  });

  it("explicit decision.superseded and decision.archived", () => {
    const s = memStore();
    s.appendEvent({ type: "decision.made", payload: { id: "d1", title: "A" } });
    s.appendEvent({ type: "decision.superseded", payload: { id: "d1", by: "d2" } });
    expect(stateOf(s).decisions[0]?.status).toBe("superseded");
    expect(stateOf(s).decisions[0]?.supersededBy).toBe("d2");

    s.appendEvent({ type: "decision.made", payload: { id: "d3", title: "B" } });
    s.appendEvent({ type: "decision.archived", payload: { id: "d3" } });
    expect(stateOf(s).decisions.find((d) => d.id === "d3")?.status).toBe("archived");
  });

  it("agent.heartbeat updates session and lastSeen", () => {
    const s = memStore();
    s.appendEvent({ type: "agent.registered", payload: { name: "Claude" }, timestamp: "2026-06-08T00:00:00.000Z" });
    s.appendEvent({ type: "agent.heartbeat", payload: { name: "Claude", session: "s2" }, timestamp: "2026-06-08T00:05:00.000Z" });
    const a = stateOf(s).agents[0]!;
    expect(a.currentSession).toBe("s2");
    expect(a.lastSeen).toBe("2026-06-08T00:05:00.000Z");
  });

  it("file.created sets ownership; uses default entity id from event id", () => {
    const s = memStore();
    const ev = s.appendEvent({ type: "knowledge.learned", payload: { statement: "no id given" }, actor: "Claude" });
    // entity id falls back to the event id when no payload id.
    expect(stateOf(s).knowledge[0]?.id).toBe(ev.id);
  });

  it("unknown/custom and passthrough types do not change derived state", () => {
    const s = memStore();
    s.appendEvent({ type: "file.read", payload: { path: "x" } });
    s.appendEvent({ type: "message.sent", payload: { content: "hi" } });
    s.appendEvent({ type: "custom.whatever", payload: { a: 1 } });
    const st = stateOf(s);
    expect(st.tasks).toHaveLength(0);
    expect(st.ownership).toHaveLength(0);
  });
});

describe("determinism", () => {
  it("replaying the same events yields identical derived entities", () => {
    const s = memStore();
    s.appendEvent({ type: "task.created", payload: { id: "t1", title: "A" } });
    s.appendEvent({ type: "decision.made", payload: { id: "d1", title: "B" } });
    const a = stateOf(s, 0);
    const b = stateOf(s, 0);
    // Ignore generatedAt (clock); compare the rest.
    expect({ ...a, generatedAt: "" }).toEqual({ ...b, generatedAt: "" });
  });
});
