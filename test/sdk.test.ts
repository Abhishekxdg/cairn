import { describe, it, expect, afterEach } from "vitest";
import { tempProject, cleanup } from "./helpers.js";
import { Stated } from "../src/index.js";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) cleanup(d);
  dirs = [];
});

async function freshSdk(agent = "Claude Code"): Promise<Stated> {
  const dir = tempProject();
  dirs.push(dir);
  const sdk = new Stated({ cwd: dir, agent });
  await sdk.init();
  await sdk.registerAgent();
  return sdk;
}

describe("Stated SDK", () => {
  it("initializes and reports state", async () => {
    const sdk = await freshSdk();
    expect(sdk.isInitialized()).toBe(true);
    const state = await sdk.getState();
    expect(state.version).toBe(1);
    expect(state.activeAgents.some((a) => a.name === "Claude Code")).toBe(true);
  });

  it("runs the full task lifecycle attributing to the configured agent", async () => {
    const sdk = await freshSdk();
    await sdk.addGoal("Launch MailMeld");
    const t = await sdk.addTask({ title: "OAuth", priority: "high" });
    await sdk.claimTask(t.id);
    const claimed = await sdk.getTask(t.id);
    expect(claimed?.owner).toBe("Claude Code");

    await sdk.startTask(t.id);
    await sdk.completeTask(t.id);
    expect((await sdk.getTask(t.id))?.status).toBe("completed");
  });

  it("accepts a string shorthand for tasks and decisions", async () => {
    const sdk = await freshSdk();
    const t = await sdk.addTask("Quick task");
    expect(t.title).toBe("Quick task");
    const d = await sdk.addDecision("Use PostgreSQL");
    expect(d.decision).toBe("Use PostgreSQL");
    expect(d.madeBy).toBe("Claude Code");
  });

  it("claims and releases files", async () => {
    const sdk = await freshSdk();
    await sdk.claimFile("src/payment.ts");
    const files = await sdk.getFiles();
    expect(files[0]?.owner).toBe("Claude Code");
    expect(await sdk.releaseFile("src/payment.ts")).toBe(true);
  });

  it("generates a handoff containing key sections", async () => {
    const sdk = await freshSdk();
    await sdk.addGoal("Ship it");
    const handoff = await sdk.getHandoff();
    expect(handoff).toContain("Goal:");
    expect(handoff).toContain("Ship it");
    expect(handoff).toContain("Next Recommended Steps");
  });

  it("two agents coordinate on the same project", async () => {
    const dir = tempProject();
    dirs.push(dir);
    const claude = new Stated({ cwd: dir, agent: "Claude Code" });
    await claude.init();
    await claude.registerAgent();
    const codex = new Stated({ cwd: dir, agent: "Codex" });
    await codex.registerAgent();

    const t = await claude.addTask("Shared work");
    await claude.claimTask(t.id);

    // Codex sees Claude owns it and cannot steal without force.
    await expect(codex.claimTask(t.id)).rejects.toThrow(/already owned/);

    const state = await codex.getState();
    expect(state.activeAgents.map((a) => a.name).sort()).toEqual([
      "Claude Code",
      "Codex",
    ]);
  });

  it("doctor reports healthy", async () => {
    const sdk = await freshSdk();
    const report = await sdk.doctor();
    expect(report.healthy).toBe(true);
  });
});
