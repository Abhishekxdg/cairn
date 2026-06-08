import { describe, it, expect, afterAll } from "vitest";
import { join } from "node:path";
import { AgentJournal } from "../src/sdk/index.js";
import { tempDir, cleanupAll } from "./helpers.js";

afterAll(cleanupAll);

function j(): AgentJournal {
  return new AgentJournal({ dbPath: join(tempDir(), "j.db"), actor: "Claude Code", projectId: "t", autoGit: false });
}

describe("AgentJournal ops surface", () => {
  it("snapshot / compactJournal / health / validate / repair", () => {
    const journal = j();
    for (let i = 0; i < 60; i++) journal.createTask({ title: `T${i}` });
    expect(journal.snapshot()).toBeGreaterThan(0);

    const comp = journal.compactJournal();
    expect(comp.archived).toBeGreaterThanOrEqual(0);

    const h = journal.health();
    expect(h.total).toBe(journal.events().length + h.archived);
    expect(journal.validate().healthy).toBe(true);
    expect(journal.repair().actions.length).toBeGreaterThan(0);
    journal.close();
  });

  it("prune + staleAgents", () => {
    const journal = j();
    journal.appendEvent({ type: "agent.registered", payload: { name: "Old" }, timestamp: "2026-01-01T00:00:00.000Z" });
    expect(journal.staleAgents().length).toBe(1);
    expect(journal.prune().pruned).toContain("Old");
    journal.close();
  });

  it("timeline render, memory, knowledge, batch, export", () => {
    const journal = j();
    journal.batchAppend([
      { type: "knowledge.learned", payload: { id: "k1", statement: "X" } },
      { type: "memory.recorded", payload: { id: "m1", content: "Y" } },
    ]);
    expect(journal.renderTimeline()).toContain("Learned");
    expect(journal.getMemory()).toHaveLength(1);
    expect(journal.getKnowledge()).toHaveLength(1);
    expect(journal.exportEvents().length).toBeGreaterThanOrEqual(2);
    expect(journal.git().isRepo === true || journal.git().isRepo === false).toBe(true);
    journal.close();
  });

  it("fileTouched + heartbeat + revertDecision", () => {
    const journal = j();
    journal.fileTouched("src/a.ts", "created");
    journal.heartbeat();
    const d = journal.decide({ title: "Use X" });
    journal.revertDecision(d.id);
    const st = journal.getState();
    expect(st.ownership[0]?.path).toBe("src/a.ts");
    expect(st.decisions[0]?.status).toBe("reverted");
    journal.close();
  });
});
