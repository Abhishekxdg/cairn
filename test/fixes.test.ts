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

  it("keeps both sides' events when they diverge at equal length", () => {
    const dir = tempDir();
    const dbPath = join(dir, "journal.db");
    const s1 = new EventStore(dbPath, { projectId: "t" });
    s1.appendEvent({ type: "custom.a", id: "a1" });
    s1.close();

    // Same count, different content (a merge or checkout replaced the line).
    writeFileSync(join(dir, "events.jsonl"), JSON.stringify(ev("z9", 1)) + "\n");

    const s2 = new EventStore(dbPath, { projectId: "t" });
    expect(s2.getById("z9")).toBeTruthy(); // the log's event reaches the cache
    expect(s2.getById("a1")).toBeTruthy(); // and the cache's is not thrown away
    s2.close();
    expect(logIds(dir)).toEqual(["z9", "a1"]);
  });

  it("never drops merged-in events when the cache holds more than the log (pull, branch switch)", () => {
    const dir = tempDir();
    const dbPath = join(dir, "journal.db");
    const s1 = new EventStore(dbPath, { projectId: "t" });
    for (const id of ["a1", "a2", "a3", "a4"]) s1.appendEvent({ type: "custom.a", id });
    s1.close();

    // git replaces the log with another branch's: it lacks a3 and a4 (recorded here
    // on the old branch) and brings m1 and m2, which this cache never saw. The
    // cache now holds more events than the log, and the log holds events the cache lacks.
    writeFileSync(
      join(dir, "events.jsonl"),
      [ev("a1", 1), ev("a2", 2), ev("m1", 3)].map((e) => JSON.stringify(e)).join("\n") + "\n",
    );

    const s2 = new EventStore(dbPath, { projectId: "t" });
    for (const id of ["a1", "a2", "a3", "a4", "m1"]) expect(s2.getById(id)).toBeTruthy();
    s2.close();
    // the log kept every line git gave it, in place, and gained the cache's others at its end
    expect(logIds(dir)).toEqual(["a1", "a2", "m1", "a3", "a4"]);

    // reopening changes nothing more
    new EventStore(dbPath, { projectId: "t" }).close();
    expect(logIds(dir)).toEqual(["a1", "a2", "m1", "a3", "a4"]);
  });

  it("loads a merged-in event whose seq the cache already gave another event", () => {
    const dir = tempDir();
    const dbPath = join(dir, "journal.db");
    const s1 = new EventStore(dbPath, { projectId: "t" });
    s1.appendEvent({ type: "custom.a", id: "a1" });
    s1.appendEvent({ type: "custom.a", id: "a2" });
    s1.close();
    // another clone numbered its own event 2 as well
    appendFileSync(join(dir, "events.jsonl"), JSON.stringify(ev("x2", 2)) + "\n");

    const s2 = new EventStore(dbPath, { projectId: "t" });
    expect(s2.getById("a2")?.seq).toBe(2);
    expect(s2.getById("x2")?.seq).toBeGreaterThan(2);
    s2.close();
  });

  it("brings no cold-archived event back and repeats no line after compaction", () => {
    const dir = tempDir();
    const dbPath = join(dir, "journal.db");
    const s1 = new EventStore(dbPath, { projectId: "t" });
    for (const id of ["a1", "a2", "a3"]) s1.appendEvent({ type: "custom.a", id });
    s1.compactEvents(2);
    s1.close();
    const before = logIds(dir);

    const s2 = new EventStore(dbPath, { projectId: "t" });
    expect(s2.count()).toBe(1); // a3 hot; a1 and a2 stay archived
    expect(s2.totalCount()).toBe(3);
    s2.close();
    expect(logIds(dir)).toEqual(before);

    // a merge brings m1: it joins the cache, and the archive stays as it was
    appendFileSync(join(dir, "events.jsonl"), JSON.stringify(ev("m1", 9)) + "\n");
    const s3 = new EventStore(dbPath, { projectId: "t" });
    expect(s3.count()).toBe(2);
    expect(s3.archivedCount()).toBe(2);
    s3.close();
    expect(logIds(dir)).toEqual([...before, "m1"]);
  });
});

/** An event as the committed log holds it. */
function ev(id: string, seq: number) {
  return {
    seq,
    id,
    timestamp: new Date().toISOString(),
    actor: "",
    sessionId: "",
    projectId: "t",
    type: "custom.x",
    version: 1,
    payload: {},
  };
}

/** The ids in a journal folder's committed log, in file order. */
function logIds(dir: string): string[] {
  return readFileSync(join(dir, "events.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => (JSON.parse(l) as { id: string }).id);
}

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
