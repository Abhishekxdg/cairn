import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { tempProject, cleanup } from "./helpers.js";

import {
  init,
  buildState,
  statedPaths,
  findProjectRoot,
  readProject,
  addGoal,
  completeGoal,
  readGoals,
  addTask,
  claimTask,
  completeTask,
  startTask,
  blockTask,
  readTasks,
  getTask,
  activeTasks,
  addDecision,
  supersedeDecision,
  readDecisions,
  registerAgent,
  readAgents,
  liveStatus,
  claimFile,
  releaseFile,
  readFiles,
  fileOwner,
  createSnapshot,
  generateHandoff,
  doctor,
  readEvents,
  detectFrameworks,
  searchProject,
  syncProject,
  bm25Search,
  tokenize,
} from "../src/core/index.js";

let dirs: string[] = [];
function project(files?: Record<string, string>): string {
  const d = tempProject(files);
  dirs.push(d);
  init(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) cleanup(d);
  dirs = [];
});

describe("init", () => {
  it("scaffolds every canonical file", () => {
    const root = project();
    const p = statedPaths(root);
    for (const f of [
      p.project,
      p.goals,
      p.tasks,
      p.decisions,
      p.agents,
      p.files,
      p.events,
      p.state,
      p.handoff,
    ]) {
      expect(existsSync(f), f).toBe(true);
    }
    expect(existsSync(p.snapshots)).toBe(true);
  });

  it("records an initialized event", () => {
    const root = project();
    expect(readEvents(root).some((e) => e.type === "initialized")).toBe(true);
  });

  it("refuses to clobber without force", () => {
    const root = project();
    expect(() => init(root)).toThrow(/already exists/);
    expect(() => init(root, { force: true })).not.toThrow();
  });

  it("findProjectRoot walks up from a subdir", () => {
    const root = project();
    expect(findProjectRoot(join(root, "a", "b", "c"))).toBe(root);
  });
});

describe("goals", () => {
  it("adds and completes goals", () => {
    const root = project();
    addGoal(root, "Launch beta");
    addGoal(root, "Ship OAuth integration");
    let g = readGoals(root);
    expect(g.active).toContain("Launch beta");

    completeGoal(root, "oauth");
    g = readGoals(root);
    expect(g.active).not.toContain("Ship OAuth integration");
    expect(g.completed).toContain("Ship OAuth integration");
  });

  it("is idempotent on duplicate add", () => {
    const root = project();
    addGoal(root, "Launch beta");
    addGoal(root, "Launch beta");
    expect(
      readGoals(root).active.filter((x) => x === "Launch beta"),
    ).toHaveLength(1);
  });

  it("throws when completing an unknown goal", () => {
    const root = project();
    expect(() => completeGoal(root, "nope")).toThrow(/No active goal/);
  });
});

describe("tasks", () => {
  it("creates, claims, starts and completes a task", () => {
    const root = project();
    const t = addTask(root, { title: "Build OAuth", priority: "high" });
    expect(t.id).toMatch(/^t_/);
    expect(t.status).toBe("todo");

    claimTask(root, t.id, "Claude Code");
    expect(getTask(root, t.id)?.status).toBe("claimed");
    expect(getTask(root, t.id)?.owner).toBe("Claude Code");

    startTask(root, t.id, "Claude Code");
    expect(getTask(root, t.id)?.status).toBe("active");

    completeTask(root, t.id, "Claude Code");
    expect(getTask(root, t.id)?.status).toBe("completed");
    expect(activeTasks(root)).toHaveLength(0);
  });

  it("prevents stealing a claimed task without force", () => {
    const root = project();
    const t = addTask(root, { title: "X" });
    claimTask(root, t.id, "Claude");
    expect(() => claimTask(root, t.id, "Codex")).toThrow(/already owned/);
    expect(() => claimTask(root, t.id, "Codex", { force: true })).not.toThrow();
    expect(getTask(root, t.id)?.owner).toBe("Codex");
  });

  it("blocks a task", () => {
    const root = project();
    const t = addTask(root, { title: "X" });
    blockTask(root, t.id, "waiting on infra");
    expect(getTask(root, t.id)?.status).toBe("blocked");
  });

  it("rejects empty titles and unknown ids", () => {
    const root = project();
    expect(() => addTask(root, { title: "  " })).toThrow(/empty/);
    expect(() => completeTask(root, "t_missing")).toThrow(/No task/);
  });
});

describe("decisions", () => {
  it("records decisions immutably via events and renders markdown", () => {
    const root = project();
    addDecision(root, {
      decision: "Use BullMQ",
      reason: "Reliable retries",
      madeBy: "Claude",
    });
    addDecision(root, { decision: "Use PostgreSQL", madeBy: "Codex" });

    const ds = readDecisions(root);
    expect(ds).toHaveLength(2);
    expect(ds[0]?.decision).toBe("Use PostgreSQL"); // newest first

    const md = readFileSync(statedPaths(root).decisions, "utf8");
    expect(md).toContain("Use BullMQ");
    expect(md).toContain("Reliable retries");
  });

  it("supersedes older decisions while preserving history", () => {
    const root = project();
    const old = addDecision(root, { decision: "Use BullMQ", madeBy: "Claude" });
    const replacement = addDecision(root, {
      decision: "Use RabbitMQ",
      madeBy: "Codex",
      supersedes: old.id,
    });

    const ds = readDecisions(root);
    expect(ds.find((d) => d.id === old.id)?.status).toBe("superseded");
    expect(ds.find((d) => d.id === old.id)?.supersededBy).toBe(replacement.id);
    expect(buildState(root).recentDecisions.map((d) => d.id)).not.toContain(
      old.id,
    );

    const md = readFileSync(statedPaths(root).decisions, "utf8");
    expect(md).toContain(`superseded by ${replacement.id}`);
  });

  it("can supersede decisions explicitly", () => {
    const root = project();
    const old = addDecision(root, { decision: "Use REST" });
    const replacement = addDecision(root, { decision: "Use GraphQL" });
    supersedeDecision(root, old.id, replacement.id, "Architect");
    expect(readDecisions(root).find((d) => d.id === old.id)?.status).toBe(
      "superseded",
    );
  });
});

describe("agents", () => {
  it("registers and infers type", () => {
    const root = project();
    registerAgent(root, "Claude Code");
    registerAgent(root, "Codex");
    const agents = readAgents(root);
    expect(agents.find((a) => a.name === "Claude Code")?.type).toBe("claude");
    expect(agents.find((a) => a.name === "Codex")?.type).toBe("codex");
  });

  it("computes liveness from lastSeen", () => {
    const root = project();
    const a = registerAgent(root, "Claude Code");
    expect(liveStatus(a, Date.parse(a.lastSeen))).toBe("active");
    const later = Date.parse(a.lastSeen) + 60 * 60 * 1000;
    expect(liveStatus(a, later)).toBe("idle");
  });
});

describe("files", () => {
  it("claims and releases with lock enforcement", () => {
    const root = project();
    claimFile(root, "src/payment.ts", "Claude");
    expect(fileOwner(root, "src/payment.ts")?.locked).toBe(true);

    expect(() => claimFile(root, "src/payment.ts", "Codex")).toThrow(/locked/);
    claimFile(root, "src/payment.ts", "Codex", { force: true });
    expect(fileOwner(root, "src/payment.ts")?.owner).toBe("Codex");

    expect(releaseFile(root, "src/payment.ts")).toBe(true);
    expect(readFiles(root)).toHaveLength(0);
    expect(releaseFile(root, "src/payment.ts")).toBe(false);
  });

  it("normalizes windows-style paths", () => {
    const root = project();
    claimFile(root, ".\\src\\a.ts", "Claude");
    expect(fileOwner(root, "src/a.ts")?.path).toBe("src/a.ts");
  });
});

describe("snapshot engine", () => {
  it("regenerates state.json and handoff.md after mutations", () => {
    const root = project();
    addGoal(root, "Launch MailMeld");
    const t = addTask(root, { title: "OAuth Integration", priority: "high" });
    startTask(root, t.id, "Claude");
    addDecision(root, { decision: "Use BullMQ", reason: "Reliable retries" });
    registerAgent(root, "Claude Code");
    claimFile(root, "src/auth.ts", "Claude Code");

    const state = buildState(root);
    expect(state.goal).toBe("Launch MailMeld");
    expect(state.activeTasks[0]?.title).toBe("OAuth Integration");
    expect(state.recentDecisions[0]?.decision).toBe("Use BullMQ");
    expect(state.lockedFiles[0]?.path).toBe("src/auth.ts");

    const handoff = readFileSync(statedPaths(root).handoff, "utf8");
    expect(handoff).toContain("Launch MailMeld");
    expect(handoff).toContain("OAuth Integration");
    expect(handoff).toContain("Next Recommended Steps");
  });

  it("marks derived state and handoff files as gitignored caches", () => {
    const root = project();
    const gitignore = readFileSync(statedPaths(root).gitignore, "utf8");
    expect(gitignore).toContain("state.json");
    expect(gitignore).toContain("handoff.md");
  });

  it("creates a self-describing snapshot directory", () => {
    const root = project();
    addTask(root, { title: "X" });
    const dir = createSnapshot(root);
    expect(existsSync(join(dir, "state.json"))).toBe(true);
    expect(existsSync(join(dir, "handoff.md"))).toBe(true);
    expect(existsSync(join(dir, "tasks.json"))).toBe(true);
  });

  it("generateHandoff returns text and logs an event", () => {
    const root = project();
    const text = generateHandoff(root);
    expect(text).toContain("# Project Handoff");
    expect(readEvents(root).some((e) => e.type === "handoff_generated")).toBe(
      true,
    );
  });
});

describe("sync", () => {
  it("proposes review for active work when git worktree is clean", () => {
    const root = project();
    const t = addTask(root, { title: "Finish OAuth" });
    startTask(root, t.id, "Claude");

    const report = syncProject(root, { actor: "Codex" });
    expect(
      report.suggestions.some(
        (s) => s.kind === "review_task" && s.target === t.id,
      ),
    ).toBe(true);
    expect(readEvents(root).some((e) => e.type === "sync_ran")).toBe(true);
  });

  it("reports dirty files from git status", () => {
    const root = project();
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    writeFileSync(join(root, "dirty.txt"), "x");
    const report = syncProject(root);
    expect(report.dirtyFiles).toContain("dirty.txt");
  });
});

describe("framework detection", () => {
  it("detects Next.js + React from package.json", () => {
    const root = tempProject({
      "package.json": JSON.stringify({
        dependencies: { next: "14", react: "18", "react-dom": "18" },
      }),
    });
    dirs.push(root);
    init(root);
    expect(detectFrameworks(root)).toEqual(
      expect.arrayContaining(["Next.js", "React"]),
    );
  });

  it("detects Django from manage.py", () => {
    const root = tempProject({
      "manage.py": "# django",
      "requirements.txt": "Django==5.0",
    });
    dirs.push(root);
    init(root);
    expect(detectFrameworks(root)).toContain("Django");
  });
});

describe("doctor", () => {
  it("reports healthy on a fresh init", () => {
    const root = project();
    const report = doctor(root);
    expect(report.healthy).toBe(true);
    expect(report.findings.some((f) => f.level === "error")).toBe(false);
  });
});

describe("project metadata", () => {
  it("parses name/description round-trip", () => {
    const root = project();
    const info = readProject(root);
    expect(info.name.length).toBeGreaterThan(0);
  });
});

describe("search (BM25)", () => {
  it("tokenizes to lowercase alphanumeric terms", () => {
    expect(tokenize("Build OAuth, v2!")).toEqual(["build", "oauth", "v2"]);
  });

  it("ranks the most relevant task first", () => {
    const root = project();
    addTask(root, {
      title: "Build OAuth login flow",
      description: "Google and GitHub",
    });
    addTask(root, { title: "Write database migrations" });
    addTask(root, { title: "Refactor billing module" });
    const hits = searchProject(root, "oauth login");
    expect(hits[0]?.type).toBe("task");
    expect(hits[0]?.title).toContain("OAuth");
    expect(hits[0]!.score).toBeGreaterThan(0);
  });

  it("searches across decisions and goals too", () => {
    const root = project();
    addDecision(root, {
      decision: "Use BullMQ for job queues",
      reason: "Reliable retries",
    });
    addGoal(root, "Launch the payments service");
    expect(searchProject(root, "bullmq")[0]?.type).toBe("decision");
    expect(searchProject(root, "payments")[0]?.type).toBe("goal");
  });

  it("filters by type and respects the limit", () => {
    const root = project();
    addTask(root, { title: "queue worker setup" });
    addDecision(root, { decision: "queue with BullMQ" });
    const onlyTasks = searchProject(root, "queue", { type: "task" });
    expect(onlyTasks.every((h) => h.type === "task")).toBe(true);
    addTask(root, { title: "queue retry queue queue" });
    expect(searchProject(root, "queue", { limit: 1 })).toHaveLength(1);
  });

  it("returns nothing for no overlap or empty query", () => {
    const root = project();
    addTask(root, { title: "Build OAuth" });
    expect(searchProject(root, "kubernetes")).toEqual([]);
    expect(searchProject(root, "")).toEqual([]);
    expect(searchProject(root, "the and of")).toEqual([]); // stopwords only
  });

  it("is deterministic and tie-breaks stably by id", () => {
    const docs = [
      { type: "task" as const, id: "t_b", title: "queue", text: "queue" },
      { type: "task" as const, id: "t_a", title: "queue", text: "queue" },
    ];
    const a = bm25Search(docs, "queue");
    const b = bm25Search(docs, "queue");
    expect(a.map((h) => h.id)).toEqual(["t_a", "t_b"]);
    expect(a).toEqual(b);
  });
});
