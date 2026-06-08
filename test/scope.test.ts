import { describe, it, expect, afterEach } from "vitest";
import { tempProject, cleanup } from "./helpers.js";

import {
  init,
  addTask,
  readTasks,
  tasksInRun,
  addDecision,
  readDecisions,
  searchProject,
} from "../src/core/index.js";
import { Stated } from "../src/sdk/index.js";

let dirs: string[] = [];
function project(): string {
  const d = tempProject();
  dirs.push(d);
  init(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) cleanup(d);
  dirs = [];
});

describe("run/session scoping (core)", () => {
  it("tags tasks with a runId and filters by it", () => {
    const root = project();
    addTask(root, { title: "scoped task", runId: "run-1" });
    addTask(root, { title: "other run", runId: "run-2" });
    addTask(root, { title: "global task" });

    expect(readTasks(root)).toHaveLength(3);
    expect(tasksInRun(root, "run-1").map((t) => t.title)).toEqual(["scoped task"]);
    expect(tasksInRun(root, "run-2")).toHaveLength(1);
    expect(tasksInRun(root, "nope")).toEqual([]);
  });

  it("omits runId entirely when unset (no empty-string noise)", () => {
    const root = project();
    const t = addTask(root, { title: "global" });
    expect("runId" in t).toBe(false);
  });

  it("carries a decision's runId through the event stream", () => {
    const root = project();
    addDecision(root, { decision: "Use BullMQ", runId: "run-1" });
    addDecision(root, { decision: "Use Postgres" });
    const ds = readDecisions(root);
    expect(ds.find((d) => d.decision === "Use BullMQ")!.runId).toBe("run-1");
    expect(ds.find((d) => d.decision === "Use Postgres")!.runId).toBeUndefined();
  });

  it("search can restrict to a run scope", () => {
    const root = project();
    addTask(root, { title: "queue worker", runId: "run-1" });
    addTask(root, { title: "queue consumer", runId: "run-2" });
    addDecision(root, { decision: "queue via BullMQ", runId: "run-1" });

    const all = searchProject(root, "queue");
    expect(all.length).toBe(3);
    const scoped = searchProject(root, "queue", { run: "run-1" });
    expect(scoped.length).toBe(2);
    expect(scoped.every((h) => h.meta["runId"] === "run-1")).toBe(true);
  });
});

describe("run/session scoping (SDK)", () => {
  it("applies the configured run to created tasks and decisions", async () => {
    const root = project();
    const s = new Stated({ cwd: root, agent: "Claude", run: "session-7" });
    const t = await s.addTask("build auth");
    const d = await s.addDecision("use JWT");
    expect(t.runId).toBe("session-7");
    expect(d.runId).toBe("session-7");
  });

  it("getTasks / getDecisions filter to the configured run", async () => {
    const root = project();
    addTask(root, { title: "outside", runId: "other" });
    const s = new Stated({ cwd: root, run: "mine" });
    await s.addTask("inside");
    expect((await s.getTasks()).map((t) => t.title)).toEqual(["inside"]);
  });

  it("an explicit per-call runId overrides the configured scope", async () => {
    const root = project();
    const s = new Stated({ cwd: root, run: "default" });
    const t = await s.addTask({ title: "override", runId: "special" });
    expect(t.runId).toBe("special");
  });

  it("a project-wide SDK (no run) sees every task", async () => {
    const root = project();
    addTask(root, { title: "a", runId: "x" });
    addTask(root, { title: "b" });
    const s = new Stated({ cwd: root });
    expect(await s.getTasks()).toHaveLength(2);
  });
});
