import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { tempDir, cleanupAll } from "./helpers.js";
import { run } from "../src/cli/index.js";

afterEach(cleanupAll);

let cwd: string;
beforeEach(() => {
  cwd = process.cwd();
});
afterEach(() => {
  process.chdir(cwd);
  vi.restoreAllMocks();
  process.exitCode = 0;
});

async function cli(args: string[], dir?: string) {
  let stdout = "";
  let stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((c: any) => { stdout += String(c); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((c: any) => { stderr += String(c); return true; });
  if (dir) process.chdir(dir);
  const code = await run(args);
  return { code, stdout, stderr };
}

describe("cairn CLI", () => {
  it("help and version", async () => {
    expect((await cli(["--version"])).stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    expect((await cli([])).stdout).toContain("Cairn");
  });

  it("init → append → status → state", async () => {
    const dir = tempDir();
    expect((await cli(["init"], dir)).stdout).toContain("created shared memory");
    await cli(["append", "--type", "agent.registered", "--payload", '{"name":"Claude Code"}', "--actor", "Claude Code"], dir);
    await cli(["append", "--type", "goal.created", "--payload", '{"id":"g1","title":"Launch"}'], dir);
    await cli(["append", "--type", "task.created", "--payload", '{"id":"t1","title":"OAuth","priority":"high"}'], dir);
    await cli(["append", "--type", "task.started", "--payload", '{"id":"t1"}', "--actor", "Claude Code"], dir);

    const status = await cli(["status"], dir);
    expect(status.stdout).toContain("Launch");
    expect(status.stdout).toContain("OAuth");

    const state = await cli(["state"], dir);
    expect(JSON.parse(state.stdout).tasks[0].id).toBe("t1");
  });

  it("context, timeline, snapshot, export", async () => {
    const dir = tempDir();
    await cli(["init"], dir);
    await cli(["append", "--type", "decision.made", "--payload", '{"id":"d1","title":"Use SQLite","rationale":"WAL"}'], dir);

    const ctx = await cli(["context", "--level", "small"], dir);
    expect(JSON.parse(ctx.stdout).activeDecisions[0].title).toBe("Use SQLite");

    expect((await cli(["timeline"], dir)).stdout).toContain("Use SQLite");
    expect((await cli(["snapshot"], dir)).stdout).toContain("Snapshot at seq");

    const exp = await cli(["export"], dir);
    expect(Array.isArray(JSON.parse(exp.stdout))).toBe(true);
  });

  it("doctor, migrate, repair, compact, prune", async () => {
    const dir = tempDir();
    await cli(["init"], dir);
    for (let i = 0; i < 10; i++) {
      await cli(["append", "--type", "custom.n", "--payload", `{"i":${i}}`], dir);
    }
    const doctor = await cli(["doctor", "--json"], dir);
    expect(JSON.parse(doctor.stdout).health.ok).toBe(true);

    expect((await cli(["migrate"], dir)).stdout).toMatch(/schema/i);
    expect((await cli(["repair"], dir)).stdout).toContain("vacuumed");
    expect((await cli(["compact"], dir)).stdout).toContain("Archived");
    expect((await cli(["prune"], dir)).stdout).toMatch(/prune|No stale/i);
  });

  it("errors without a journal and on unknown command", async () => {
    const dir = tempDir();
    const noJournal = await cli(["status"], dir);
    expect(noJournal.code).toBe(1);
    expect(noJournal.stderr).toContain("cairn init");

    const unknown = await cli(["frobnicate"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("Unknown command");
  });

  it("append requires --type and valid JSON", async () => {
    const dir = tempDir();
    await cli(["init"], dir);
    expect((await cli(["append"], dir)).code).toBe(1);
    expect((await cli(["append", "--type", "custom.x", "--payload", "{bad"], dir)).stderr).toContain("valid JSON");
  });
});
