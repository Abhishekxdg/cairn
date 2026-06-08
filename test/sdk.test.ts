import { describe, it, expect, afterAll } from "vitest";
import { join } from "node:path";
import { AgentJournal } from "../src/sdk/index.js";
import { init } from "../src/core/manifest.js";
import { tempDir, cleanupAll } from "./helpers.js";

afterAll(cleanupAll);

function journal(actor = "Claude Code"): AgentJournal {
  const dir = tempDir();
  return new AgentJournal({ dbPath: join(dir, "j.db"), actor, projectId: "test", autoGit: false });
}

describe("AgentJournal SDK", () => {
  it("runs a task lifecycle and derives state", () => {
    const j = journal();
    j.registerAgent();
    const goal = j.createGoal({ title: "Launch" });
    const { id } = j.createTask({ title: "OAuth", priority: "high" });
    j.startTask(id);
    j.completeTask(id);

    const st = j.getState();
    expect(st.goals.find((g) => g.id === goal)?.title).toBe("Launch");
    expect(st.tasks.find((t) => t.id === id)?.status).toBe("completed");
    j.close();
  });

  it("records decisions with supersession", () => {
    const j = journal();
    const a = j.decide({ title: "Use PostgreSQL" });
    j.decide({ title: "Use CockroachDB", supersedes: a.id });
    const active = j.getState().decisions.filter((d) => d.status === "active");
    expect(active).toHaveLength(1);
    expect(active[0]?.title).toBe("Use CockroachDB");
    j.close();
  });

  it("compiles context and logs a context.generated event", () => {
    const j = journal();
    j.createGoal({ title: "Ship" });
    const before = j.events().length;
    const ctx = j.getContext("small");
    expect(ctx.goal).toBe("Ship");
    expect(j.events().length).toBe(before + 1);
    expect(j.events({ types: ["context.generated"] })).toHaveLength(1);
    j.close();
  });

  it("derives memory and knowledge", () => {
    const j = journal();
    j.recordMemory("User prefers tabs", ["pref"]);
    j.learn("Rate limit is 100/s");
    expect(j.getMemory()).toHaveLength(1);
    expect(j.getKnowledge()).toHaveLength(1);
    j.close();
  });

  it("idempotent append via explicit id", () => {
    const j = journal();
    j.appendEvent({ id: "once", type: "custom.x", payload: { v: 1 } });
    j.appendEvent({ id: "once", type: "custom.x", payload: { v: 2 } });
    expect(j.events({ types: ["custom.x"] })).toHaveLength(1);
    j.close();
  });

  it("two agents share one journal file", () => {
    const dir = tempDir();
    const dbPath = join(dir, "shared.db");
    const claude = new AgentJournal({ dbPath, actor: "Claude Code", projectId: "test", autoGit: false });
    const codex = new AgentJournal({ dbPath, actor: "Codex", projectId: "test", autoGit: false });
    claude.registerAgent();
    const { id } = claude.createTask({ title: "Shared" });
    codex.completeTask(id);
    // Codex's view reflects Claude's task.
    expect(codex.getState().tasks.find((t) => t.id === id)?.status).toBe("completed");
    expect(codex.getState().tasks.find((t) => t.id === id)?.completedBy).toBe("Codex");
    claude.close();
    codex.close();
  });

  it("init creates a real journal on disk", () => {
    const dir = tempDir();
    const res = init(dir, { name: "Demo" });
    expect(res.projectId).toMatch(/^proj_/);
    const j = new AgentJournal({ cwd: dir, actor: "tester" });
    expect(j.isInitialized()).toBe(true);
    expect(j.manifest().name).toBe("Demo");
    j.close();
  });
});
