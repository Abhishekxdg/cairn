import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import {
  writeFileSync,
  appendFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tempDir, cleanupAll } from "./helpers.js";
import { EventStore } from "../src/core/store.js";
import { syncGit } from "../src/engines/gitsync.js";
import { setupProject, installGitHook } from "../src/setup/install.js";
import { upsertBetween, BEGIN_MARKER, END_MARKER, rulesBlock } from "../src/setup/rules.js";

afterAll(cleanupAll);

function gitRepo(): string {
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

describe("gitsync never journals the journal itself", () => {
  it("skips commits that touch only .agent/ and never records .agent file events", () => {
    const dir = gitRepo();
    commit(dir, "seed.txt", "x", "seed");
    const s = new EventStore(join(dir, ".agent", "journal.db"), { projectId: "git" });
    syncGit(s, dir); // baseline at HEAD

    // A commit touching ONLY the journal → no git.commit, no file events.
    commit(dir, ".agent/note.txt", "x", "chore(cairn): sync journal");
    syncGit(s, dir);
    expect(s.queryEvents({ types: ["git.commit"] }).length).toBe(0);

    // A real commit → real file captured, .agent paths filtered out.
    commit(dir, "real.ts", "export const x = 1", "feat: real file");
    syncGit(s, dir);
    const files = s.queryEvents({}).filter((e) => e.type.startsWith("file."));
    expect(files.some((f) => f.payload["path"] === "real.ts")).toBe(true);
    expect(files.some((f) => String(f.payload["path"]).startsWith(".agent"))).toBe(false);
    s.close();
  });
});

describe("post-commit hook commits the journal (no dangling dirty tree)", () => {
  it("installs an auto-commit hook guarded against recursion", () => {
    const dir = gitRepo();
    commit(dir, "r.txt", "x", "init");
    const r = setupProject(dir, {});
    expect(r.gitHook).toBe(true);
    const hook = readFileSync(join(dir, ".git", "hooks", "post-commit"), "utf8");
    expect(hook).toContain("cairn sync");
    expect(hook).toContain("CAIRN_SKIP_HOOK"); // recursion guard
    expect(hook).toContain("chore(cairn): sync journal"); // follow-up commit
  });

  it("honors core.hooksPath (Husky/Lefthook) instead of writing a dead hook", () => {
    const dir = gitRepo();
    execFileSync("git", ["config", "core.hooksPath", ".husky"], {
      cwd: dir,
      stdio: "ignore",
    });
    commit(dir, "r.txt", "x", "init");
    expect(installGitHook(dir)).toBe(true);
    expect(existsSync(join(dir, ".husky", "post-commit"))).toBe(true);
  });
});

describe("store reconciles the committed log as the source of truth", () => {
  it("catches the cache up when events.jsonl is ahead (merged-in history)", () => {
    const dir = tempDir();
    const dbPath = join(dir, "journal.db");
    const s1 = new EventStore(dbPath, { projectId: "t" });
    s1.appendEvent({ type: "custom.a", id: "a1" });
    s1.close();

    // Simulate a merge that added an event straight to the committed log.
    const extra = {
      seq: 2,
      id: "b2",
      timestamp: new Date().toISOString(),
      actor: "",
      sessionId: "",
      projectId: "t",
      type: "custom.b",
      version: 1,
      payload: {},
    };
    appendFileSync(join(dir, "events.jsonl"), JSON.stringify(extra) + "\n");

    const s2 = new EventStore(dbPath, { projectId: "t" });
    expect(s2.count()).toBe(2); // cache caught up to the log
    expect(s2.getById("b2")).toBeTruthy();
    s2.close();
  });

  it("rebuilds the cache from the log when they diverge at equal length", () => {
    const dir = tempDir();
    const dbPath = join(dir, "journal.db");
    const s1 = new EventStore(dbPath, { projectId: "t" });
    s1.appendEvent({ type: "custom.a", id: "a1" });
    s1.close();

    // Same count, different content (e.g. a bad merge rewrote the line).
    const replaced = {
      seq: 1,
      id: "z9",
      timestamp: new Date().toISOString(),
      actor: "",
      sessionId: "",
      projectId: "t",
      type: "custom.z",
      version: 1,
      payload: {},
    };
    writeFileSync(join(dir, "events.jsonl"), JSON.stringify(replaced) + "\n");

    const s2 = new EventStore(dbPath, { projectId: "t" });
    expect(s2.getById("z9")).toBeTruthy(); // log wins
    expect(s2.getById("a1")).toBeFalsy();
    s2.close();
  });
});

describe("schema refuses a journal newer than the binary", () => {
  it("throws instead of silently mis-reading a future schema", () => {
    const dir = tempDir();
    const dbPath = join(dir, "journal.db");
    const s = new EventStore(dbPath, { projectId: "t" });
    s.setMeta("schema_version", "999");
    s.close();
    expect(() => new EventStore(dbPath, { projectId: "t" })).toThrow(/newer than this cairn/);
  });
});

describe("upsertBetween is idempotent even with a truncated block", () => {
  it("replaces a BEGIN-without-END block instead of stacking a duplicate", () => {
    const truncated = `# My notes\n\n${BEGIN_MARKER}\nold partial (END marker lost)`;
    const block = rulesBlock("cairn");
    const r1 = upsertBetween(truncated, BEGIN_MARKER, END_MARKER, block);
    expect(r1.content).toContain("# My notes"); // user content preserved
    const r2 = upsertBetween(r1.content, BEGIN_MARKER, END_MARKER, block);
    expect(r2.content).toBe(r1.content); // idempotent
    expect((r2.content.match(new RegExp(BEGIN_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length).toBe(1);
  });
});
