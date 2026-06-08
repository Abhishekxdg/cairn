import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tempDir, cleanupAll } from "./helpers.js";
import { detectGit, gitCorrelation } from "../src/engines/git.js";

afterAll(cleanupAll);

function gitInit(dir: string) {
  const opt = { cwd: dir, stdio: "ignore" as const };
  execFileSync("git", ["init", "-q"], opt);
  execFileSync("git", ["config", "user.email", "t@t.dev"], opt);
  execFileSync("git", ["config", "user.name", "t"], opt);
  writeFileSync(join(dir, "f.txt"), "hi");
  execFileSync("git", ["add", "."], opt);
  execFileSync("git", ["commit", "-qm", "init"], opt);
}

describe("git integration", () => {
  it("returns not-a-repo outside git", () => {
    const dir = tempDir();
    const g = detectGit(dir);
    expect(g.isRepo).toBe(false);
    expect(gitCorrelation(dir)).toEqual({});
  });

  it("detects branch and commit in a real repo", () => {
    const dir = tempDir();
    gitInit(dir);
    const g = detectGit(dir);
    expect(g.isRepo).toBe(true);
    expect(g.branch).toBeTruthy();
    expect(g.commit).toMatch(/^[0-9a-f]{40}$/);

    const corr = gitCorrelation(dir);
    expect(corr["gitBranch"]).toBe(g.branch);
    expect(corr["gitCommit"]).toBe(g.commit);
  });

  it("detects repo from a subdirectory", () => {
    const dir = tempDir();
    gitInit(dir);
    const sub = join(dir, "a", "b");
    mkdirSync(sub, { recursive: true });
    expect(detectGit(sub).isRepo).toBe(true);
  });
});
