import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { tempProject, cleanup } from "./helpers.js";
import {
  init,
  addTask,
  claimTask,
  startTask,
  verifyTask,
  getTask,
  claimFile,
  verifyFile,
  fileOwner,
  buildState,
  generateHandoff,
  doctor,
  statedPaths,
  writeConfig,
  loadConfig,
  DEFAULT_CONFIG,
  confidenceFor,
  ageLabel,
  taskVerifiedAt,
  readTasks,
  writeTasks,
} from "../src/core/index.js";

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

const HOUR = 3_600_000;
const DAY = 86_400_000;

describe("confidenceFor", () => {
  const cfg = DEFAULT_CONFIG; // task aging>24h stale>168h; lock aging>4h stale>24h
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  const iso = new Date(base).toISOString();

  it("tiers tasks by age", () => {
    expect(confidenceFor("task", iso, base, cfg)).toBe("fresh");
    expect(confidenceFor("task", iso, base + 25 * HOUR, cfg)).toBe("aging");
    expect(confidenceFor("task", iso, base + 8 * DAY, cfg)).toBe("stale");
  });

  it("tiers locks faster than tasks", () => {
    expect(confidenceFor("lock", iso, base + 5 * HOUR, cfg)).toBe("aging");
    expect(confidenceFor("lock", iso, base + 25 * HOUR, cfg)).toBe("stale");
  });

  it("respects a config override", () => {
    const strict = {
      ...cfg,
      staleness: { ...cfg.staleness, task: { agingHours: 1, staleHours: 2 } },
    };
    expect(confidenceFor("task", iso, base + 90 * 60 * 1000, strict)).toBe("aging");
    expect(confidenceFor("task", iso, base + 3 * HOUR, strict)).toBe("stale");
  });
});

describe("ageLabel", () => {
  it("formats coarsely", () => {
    expect(ageLabel(10_000)).toBe("just now");
    expect(ageLabel(5 * 60_000)).toBe("5m");
    expect(ageLabel(3 * HOUR)).toBe("3h");
    expect(ageLabel(2 * DAY)).toBe("2 days");
    expect(ageLabel(21 * DAY)).toBe("3 weeks");
  });
});

describe("legacy fallback", () => {
  it("uses updatedAt when lastVerifiedAt is absent", () => {
    const root = project();
    const t = addTask(root, { title: "Legacy" });
    // Simulate old data: strip lastVerifiedAt on disk.
    const tasks = readTasks(root);
    delete (tasks[0] as { lastVerifiedAt?: string }).lastVerifiedAt;
    writeTasks(root, tasks);
    const reloaded = getTask(root, t.id)!;
    expect(reloaded.lastVerifiedAt).toBeUndefined();
    expect(taskVerifiedAt(reloaded)).toBe(reloaded.updatedAt);
  });
});

describe("config", () => {
  it("returns defaults with no file", () => {
    const root = project();
    expect(loadConfig(root)).toEqual(DEFAULT_CONFIG);
  });

  it("deep-merges a partial config over defaults", () => {
    const root = project();
    writeConfig(root, {
      ...DEFAULT_CONFIG,
      staleness: {
        ...DEFAULT_CONFIG.staleness,
        task: { agingHours: 2, staleHours: 5 },
      },
    });
    const cfg = loadConfig(root);
    expect(cfg.staleness.task).toEqual({ agingHours: 2, staleHours: 5 });
    expect(cfg.staleness.lock).toEqual(DEFAULT_CONFIG.staleness.lock);
  });
});

describe("freshness in state", () => {
  it("carries per-fact confidence and an aggregate banner", () => {
    const root = project();
    const t = addTask(root, { title: "OAuth" });
    startTask(root, t.id, "Claude");
    claimFile(root, "src/auth.ts", "Claude");

    const fresh = buildState(root);
    expect(fresh.activeTasks[0]?.confidence).toBe("fresh");
    expect(fresh.lockedFiles[0]?.confidence).toBe("fresh");
    expect(fresh.freshness.overall).toBe("fresh");
    expect(fresh.freshness.counts.fresh).toBe(2);

    // Look 10 days into the future: task stale, lock stale.
    const later = buildState(root, Date.now() + 10 * DAY);
    expect(later.activeTasks[0]?.confidence).toBe("stale");
    expect(later.lockedFiles[0]?.confidence).toBe("stale");
    expect(later.freshness.overall).toBe("stale");
    expect(later.freshness.counts.stale).toBe(2);
  });
});

describe("verify refreshes the clock without editing", () => {
  it("verifyTask updates lastVerifiedAt only", () => {
    const root = project();
    const t = addTask(root, { title: "X" });
    const before = getTask(root, t.id)!;
    const verified = verifyTask(root, t.id, "Claude");
    expect(verified.lastVerifiedAt! >= before.lastVerifiedAt!).toBe(true);
    expect(verified.title).toBe("X");
    expect(verified.status).toBe(before.status);
  });

  it("verifyFile updates lastVerifiedAt", () => {
    const root = project();
    claimFile(root, "src/a.ts", "Claude");
    const v = verifyFile(root, "src/a.ts", "Claude");
    expect(v.lastVerifiedAt).toBeTruthy();
    expect(fileOwner(root, "src/a.ts")?.owner).toBe("Claude");
  });

  it("verify throws on unknown target", () => {
    const root = project();
    expect(() => verifyTask(root, "t_nope")).toThrow(/No task/);
    expect(() => verifyFile(root, "nope.ts")).toThrow(/No claim/);
  });
});

describe("handoff + doctor surface staleness", () => {
  it("handoff shows a freshness banner and inline age", () => {
    const root = project();
    const t = addTask(root, { title: "OAuth" });
    claimTask(root, t.id, "Claude");
    // Backdate the task far into the past so it renders stale.
    const tasks = readTasks(root);
    tasks[0]!.lastVerifiedAt = new Date(Date.now() - 30 * DAY).toISOString();
    writeTasks(root, tasks);

    const handoff = generateHandoff(root);
    expect(handoff).toContain("Freshness:");
    expect(handoff).toMatch(/⚠ 1 stale|stale/);
    expect(handoff).toContain("OAuth");
  });

  it("doctor flags a stale fact as the rot detector", () => {
    const root = project();
    const t = addTask(root, { title: "Payments" });
    startTask(root, t.id, "Claude");
    const tasks = readTasks(root);
    tasks[0]!.lastVerifiedAt = new Date(Date.now() - 30 * DAY).toISOString();
    writeTasks(root, tasks);

    const report = doctor(root);
    const stale = report.findings.find((f) => /stale/.test(f.message));
    expect(stale).toBeTruthy();
    expect(stale?.level).toBe("warn");
    expect(stale?.message).toContain(t.id);
  });
});
