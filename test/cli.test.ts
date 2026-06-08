import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { tempProject, cleanup } from "./helpers.js";
import { run } from "../src/cli/index.js";

let dirs: string[] = [];
let cwd: string;

beforeEach(() => {
  cwd = process.cwd();
});
afterEach(() => {
  process.chdir(cwd);
  for (const d of dirs) cleanup(d);
  dirs = [];
  vi.restoreAllMocks();
  process.exitCode = 0;
});

/** Run a CLI command in a temp project, capturing stdout/stderr. */
async function cli(
  args: string[],
  project?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
    stderr += String(chunk);
    return true;
  });
  if (project) process.chdir(project);
  const code = await run(args);
  return { code, stdout, stderr };
}

function newProject(): string {
  const d = tempProject();
  dirs.push(d);
  return d;
}

describe("CLI", () => {
  it("prints help with no args", async () => {
    const { code, stdout } = await cli([]);
    expect(code).toBe(0);
    expect(stdout).toContain("shared state layer for AI coding agents");
  });

  it("prints version", async () => {
    const { stdout } = await cli(["--version"]);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("init then status", async () => {
    const p = newProject();
    const initRes = await cli(["init"], p);
    expect(initRes.code).toBe(0);
    expect(initRes.stdout).toContain("Initialized");

    const status = await cli(["status", "--json"], p);
    const state = JSON.parse(status.stdout);
    expect(state.version).toBe(1);
  });

  it("full coordination flow over the CLI", async () => {
    const p = newProject();
    await cli(["init"], p);
    await cli(["agent", "register", "Claude Code"], p);
    await cli(["goal", "add", "Launch MailMeld"], p);

    const add = await cli(["task", "add", "Build OAuth", "--priority", "high"], p);
    const id = add.stdout.match(/t_[0-9a-f]{8}/)?.[0];
    expect(id).toBeTruthy();

    const claim = await cli(["task", "claim", id!, "--agent", "Claude Code"], p);
    expect(claim.code).toBe(0);
    expect(claim.stdout).toContain("claimed");

    await cli(["decision", "add", "Use BullMQ", "--reason", "Reliable retries"], p);
    await cli(["file", "claim", "src/auth.ts", "--agent", "Claude Code"], p);

    const handoff = await cli(["handoff"], p);
    expect(handoff.stdout).toContain("Launch MailMeld");
    expect(handoff.stdout).toContain("Build OAuth");
    expect(handoff.stdout).toContain("src/auth.ts");

    const complete = await cli(["task", "complete", id!], p);
    expect(complete.stdout).toContain("Completed");

    const doctor = await cli(["doctor", "--json"], p);
    expect(JSON.parse(doctor.stdout).healthy).toBe(true);
  });

  it("errors helpfully when not initialized", async () => {
    const p = newProject();
    const { code, stderr } = await cli(["status"], p);
    expect(code).toBe(1);
    expect(stderr).toContain("stated init");
  });

  it("rejects unknown commands", async () => {
    const { code, stderr } = await cli(["frobnicate"]);
    expect(code).toBe(1);
    expect(stderr).toContain("Unknown command");
  });
});
