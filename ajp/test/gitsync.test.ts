import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, cleanupAll } from "./helpers.js";
import { EventStore } from "../src/core/store.js";
import { syncGit, gitDrift } from "../src/engines/gitsync.js";
import { deriveState } from "../src/engines/state.js";
import { setupProject, installGitHook } from "../src/setup/install.js";

afterAll(cleanupAll);

function repo(): string {
  const dir = tempDir();
  const opt = { cwd: dir, stdio: "ignore" as const };
  execFileSync("git", ["init", "-q"], opt);
  execFileSync("git", ["config", "user.email", "dev@x.dev"], opt);
  execFileSync("git", ["config", "user.name", "Dev"], opt);
  return dir;
}
function commit(dir: string, file: string, content: string, msg: string) {
  const p = join(dir, file);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
  const opt = { cwd: dir, stdio: "ignore" as const };
  execFileSync("git", ["add", "-A"], opt);
  execFileSync("git", ["commit", "-qm", msg], opt);
}
function store(dir: string): EventStore {
  return new EventStore(join(dir, ".agent", "journal.db"), { projectId: "git" });
}

describe("git drift (freshness signal)", () => {
  it("is 0 right after sync and grows with each un-synced commit", () => {
    const dir = repo();
    commit(dir, "README.md", "# hi", "initial");
    const s = store(dir);
    syncGit(s, dir); // baseline at HEAD
    expect(gitDrift(s, dir)).toBe(0);

    commit(dir, "a.ts", "1", "a");
    commit(dir, "b.ts", "2", "b");
    expect(gitDrift(s, dir)).toBe(2); // two commits the journal hasn't captured

    syncGit(s, dir); // catch up
    expect(gitDrift(s, dir)).toBe(0);
    s.close();
  });

  it("is 0 when there is no baseline or no git", () => {
    const dir = repo();
    const s = store(dir);
    expect(gitDrift(s, dir)).toBe(0); // no baseline yet
    s.close();
  });
});

describe("git auto-capture", () => {
  it("baselines on first sync, then captures new commits as file events", () => {
    const dir = repo();
    commit(dir, "README.md", "# hi", "initial");
    const s = store(dir);

    // First sync sets a baseline (does not replay pre-existing history).
    let r = syncGit(s, dir);
    expect(r.synced).toBe(true);
    expect(r.events).toBe(0);

    // New commit after baseline is captured automatically.
    commit(dir, "src/auth.ts", "export const x = 1", "add auth");
    r = syncGit(s, dir);
    expect(r.commits).toBe(1);
    expect(r.events).toBeGreaterThanOrEqual(2); // git.commit + file.created

    const created = s.queryEvents({ types: ["file.created"] });
    expect(created.some((e) => e.payload["path"] === "src/auth.ts")).toBe(true);
    expect(created[0]?.actor).toBe("Dev"); // attributed to the commit author
    expect(s.queryEvents({ types: ["git.commit"] })).toHaveLength(1);
    s.close();
  });

  it("is idempotent — re-syncing the same HEAD adds nothing", () => {
    const dir = repo();
    commit(dir, "a.txt", "1", "c1");
    const s = store(dir);
    syncGit(s, dir);
    commit(dir, "b.txt", "2", "c2");
    syncGit(s, dir);
    const n = s.count();
    syncGit(s, dir); // no new commits
    syncGit(s, dir);
    expect(s.count()).toBe(n);
    s.close();
  });

  it("--full captures the entire history; ownership derives from git", () => {
    const dir = repo();
    commit(dir, "x.ts", "a", "c1");
    commit(dir, "x.ts", "ab", "c2");
    commit(dir, "y.ts", "c", "c3");
    const s = store(dir);
    const r = syncGit(s, dir, { full: true });
    expect(r.commits).toBe(3);

    const state = deriveState(s);
    const own = state.ownership.find((o) => o.path === "x.ts");
    expect(own?.owner).toBe("Dev");
    expect(state.ownership.some((o) => o.path === "y.ts")).toBe(true);
    s.close();
  });

  it("captures modify and delete", () => {
    const dir = repo();
    commit(dir, "f.ts", "v1", "create");
    const s = store(dir);
    syncGit(s, dir); // baseline
    commit(dir, "f.ts", "v2", "modify");
    execFileSync("git", ["rm", "-q", "f.ts"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["commit", "-qm", "delete"], { cwd: dir, stdio: "ignore" });
    syncGit(s, dir);
    expect(s.queryEvents({ types: ["file.modified"] }).length).toBeGreaterThan(0);
    expect(s.queryEvents({ types: ["file.deleted"] }).length).toBeGreaterThan(0);
    // After deletion, ownership no longer lists the file.
    expect(deriveState(s).ownership.some((o) => o.path === "f.ts")).toBe(false);
    s.close();
  });

  it("setup installs a post-commit hook that runs ajp sync", () => {
    const dir = repo();
    commit(dir, "readme", "x", "init");
    const r = setupProject(dir, { all: false });
    expect(r.gitHook).toBe(true);
    const hook = readFileSync(join(dir, ".git", "hooks", "post-commit"), "utf8");
    expect(hook).toContain("ajp sync");
    expect(existsSync(join(dir, ".git", "hooks", "post-commit"))).toBe(true);

    // Idempotent + preserves an existing hook.
    writeFileSync(join(dir, ".git", "hooks", "post-commit"), "#!/bin/sh\necho keep\n");
    installGitHook(dir);
    const hook2 = readFileSync(join(dir, ".git", "hooks", "post-commit"), "utf8");
    expect(hook2).toContain("echo keep");
    expect(hook2).toContain("ajp sync");
  });

  it("no-ops cleanly outside a git repo", () => {
    const dir = tempDir();
    const s = store(dir);
    const r = syncGit(s, dir);
    expect(r.synced).toBe(false);
    s.close();
  });
});

describe("intent auto-extraction from commit messages", () => {
  it("extracts a structured `Decision:`/`Reason:` into an active decision", () => {
    const dir = repo();
    commit(dir, "seed", "x", "init");
    const s = store(dir);
    syncGit(s, dir); // baseline
    const opt = { cwd: dir, stdio: "ignore" as const };
    writeFileSync(join(dir, "q.ts"), "x");
    execFileSync("git", ["add", "-A"], opt);
    execFileSync("git", ["commit", "-qm", "add queue\n\nDecision: Use BullMQ\nReason: reliable retries"], opt);

    const r = syncGit(s, dir);
    expect(r.decisions).toBeGreaterThanOrEqual(1);
    const active = deriveState(s).decisions.filter((d) => d.status === "active");
    const bull = active.find((d) => d.title === "Use BullMQ");
    expect(bull?.rationale).toBe("reliable retries");
    s.close();
  });

  it("extracts a heuristic decision from a decisive subject", () => {
    const dir = repo();
    commit(dir, "seed", "x", "init");
    const s = store(dir);
    syncGit(s, dir);
    commit(dir, "db.ts", "x", "switch to PostgreSQL for storage");
    const r = syncGit(s, dir);
    expect(r.decisions).toBe(1);
    const d = deriveState(s).decisions.find((x) => /PostgreSQL/.test(x.title));
    expect(d).toBeTruthy();
    expect(d?.madeBy).toBe("Dev");
    s.close();
  });

  it("does not invent a decision from an ordinary commit", () => {
    const dir = repo();
    commit(dir, "seed", "x", "init");
    const s = store(dir);
    syncGit(s, dir);
    commit(dir, "a.ts", "x", "fix typo in readme");
    const r = syncGit(s, dir);
    expect(r.decisions).toBe(0);
    s.close();
  });

  it("--no-extract disables extraction", () => {
    const dir = repo();
    commit(dir, "seed", "x", "init");
    const s = store(dir);
    syncGit(s, dir);
    commit(dir, "b.ts", "x", "use Redis for caching");
    const r = syncGit(s, dir, { extractIntent: false });
    expect(r.decisions).toBe(0);
    s.close();
  });
});
