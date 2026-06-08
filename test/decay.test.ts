import { describe, it, expect, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tempProject, cleanup } from "./helpers.js";

import {
  init,
  addTask,
  completeTask,
  verifyTask,
  getTask,
  claimFile,
  verifyFile,
  fileOwner,
  readEvents,
  // config
  DEFAULT_CONFIG,
  loadConfig,
  writeConfig,
  thresholdsFor,
  tierFor,
  // staleness
  viewTask,
  viewFile,
  ageMsOf,
  ageLabel,
  summarize,
  taskVerifiedAt,
  // decay
  applyDecay,
  type StatedConfig,
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

describe("config", () => {
  it("returns defaults when no config.json exists", () => {
    const root = project();
    expect(loadConfig(root)).toEqual(DEFAULT_CONFIG);
  });

  it("deep-merges a partial config over the defaults", () => {
    const root = project();
    writeConfig(root, {
      staleness: { task: { agingHours: 1, staleHours: 2 }, lock: DEFAULT_CONFIG.staleness.lock },
      decay: { ...DEFAULT_CONFIG.decay, eventRetention: 100 },
    });
    const cfg = loadConfig(root);
    expect(cfg.staleness.task).toEqual({ agingHours: 1, staleHours: 2 });
    // Untouched keys keep their defaults.
    expect(cfg.staleness.lock).toEqual(DEFAULT_CONFIG.staleness.lock);
    expect(cfg.decay.eventRetention).toBe(100);
    expect(cfg.decay.lockAutoReleaseHours).toBe(0);
  });

  it("tierFor maps age to fresh/aging/stale at the thresholds", () => {
    const t = thresholdsFor(DEFAULT_CONFIG, "task"); // aging 24h, stale 168h
    expect(tierFor(0, t)).toBe("fresh");
    expect(tierFor(23 * HOUR, t)).toBe("fresh");
    expect(tierFor(24 * HOUR, t)).toBe("aging");
    expect(tierFor(100 * HOUR, t)).toBe("aging");
    expect(tierFor(168 * HOUR, t)).toBe("stale");
  });
});

describe("staleness derivation", () => {
  it("ageMsOf never goes negative and tolerates bad input", () => {
    const now = Date.parse("2026-06-08T00:00:00.000Z");
    expect(ageMsOf("2026-06-07T00:00:00.000Z", now)).toBe(DAY);
    expect(ageMsOf("2099-01-01T00:00:00.000Z", now)).toBe(0); // future → clamped
    expect(ageMsOf("not-a-date", now)).toBe(0);
  });

  it("viewTask annotates confidence + age from lastVerifiedAt", () => {
    const root = project();
    const task = addTask(root, { title: "Build OAuth" });
    const created = Date.parse(taskVerifiedAt(task));
    const fresh = viewTask(task, created + HOUR, DEFAULT_CONFIG);
    expect(fresh.confidence).toBe("fresh");
    expect(fresh.ageMs).toBe(HOUR);
    const stale = viewTask(task, created + 200 * HOUR, DEFAULT_CONFIG);
    expect(stale.confidence).toBe("stale");
  });

  it("viewFile decays faster than tasks (4h aging / 24h stale)", () => {
    const root = project();
    const rec = claimFile(root, "src/auth.ts", "Claude");
    const base = Date.parse(rec.claimedAt);
    expect(viewFile(rec, base + 5 * HOUR, DEFAULT_CONFIG).confidence).toBe("aging");
    expect(viewFile(rec, base + 25 * HOUR, DEFAULT_CONFIG).confidence).toBe("stale");
  });

  it("summarize rolls up to the worst confidence", () => {
    const f = summarize([
      { confidence: "fresh", iso: "2026-06-01T00:00:00.000Z" },
      { confidence: "stale", iso: "2026-06-08T00:00:00.000Z" },
      { confidence: "aging", iso: "2026-06-05T00:00:00.000Z" },
    ]);
    expect(f.overall).toBe("stale");
    expect(f.counts).toEqual({ fresh: 1, aging: 1, stale: 1 });
    expect(f.lastActivityAt).toBe("2026-06-08T00:00:00.000Z");
  });

  it("ageLabel renders coarse human spans", () => {
    expect(ageLabel(30_000)).toBe("just now");
    expect(ageLabel(5 * 60_000)).toBe("5m");
    expect(ageLabel(3 * HOUR)).toBe("3h");
    expect(ageLabel(2 * DAY)).toBe("2 days");
    expect(ageLabel(21 * DAY)).toBe("3 weeks");
  });
});

describe("verify resets the staleness clock", () => {
  it("verifyTask refreshes lastVerifiedAt and logs an event", async () => {
    const root = project();
    const task = addTask(root, { title: "Build OAuth" });
    const before = taskVerifiedAt(task);
    await new Promise((r) => setTimeout(r, 5));
    const verified = verifyTask(root, task.id, "Claude");
    expect(verified.lastVerifiedAt! > before).toBe(true);
    // Content is unchanged.
    expect(getTask(root, task.id)!.title).toBe("Build OAuth");
    expect(readEvents(root).some((e) => e.type === "memory_verified")).toBe(true);
  });

  it("verifyFile refreshes a lock's lastVerifiedAt", async () => {
    const root = project();
    claimFile(root, "src/auth.ts", "Claude");
    const before = fileOwner(root, "src/auth.ts")!.lastVerifiedAt;
    await new Promise((r) => setTimeout(r, 5));
    const rec = verifyFile(root, "src/auth.ts", "Claude");
    expect(before === undefined || rec.lastVerifiedAt! > before).toBe(true);
  });

  it("verifyTask throws for an unknown id", () => {
    const root = project();
    expect(() => verifyTask(root, "t_missing")).toThrow();
  });
});

describe("decay", () => {
  const config = (over: Partial<StatedConfig["decay"]>): StatedConfig => ({
    ...DEFAULT_CONFIG,
    decay: { ...DEFAULT_CONFIG.decay, ...over },
  });

  it("is a no-op when every policy is disabled (all zero)", () => {
    const root = project();
    claimFile(root, "src/a.ts", "Claude");
    const report = applyDecay(root, { apply: true, now: Date.now() + 999 * DAY });
    expect(report.actions).toEqual([]);
    expect(report.applied).toBe(true);
  });

  it("dry-run proposes lock release without mutating", () => {
    const root = project();
    const rec = claimFile(root, "src/a.ts", "Claude");
    const now = Date.parse(rec.claimedAt) + 50 * HOUR;
    const report = applyDecay(root, {
      apply: false,
      now,
      config: config({ lockAutoReleaseHours: 24 }),
    });
    expect(report.applied).toBe(false);
    expect(report.actions).toHaveLength(1);
    expect(report.actions[0]!.kind).toBe("release_lock");
    // Lock still present — dry run.
    expect(fileOwner(root, "src/a.ts")).toBeDefined();
  });

  it("apply releases an abandoned lock", () => {
    const root = project();
    const rec = claimFile(root, "src/a.ts", "Claude");
    const now = Date.parse(rec.claimedAt) + 50 * HOUR;
    applyDecay(root, { apply: true, now, config: config({ lockAutoReleaseHours: 24 }) });
    expect(fileOwner(root, "src/a.ts")).toBeUndefined();
    expect(readEvents(root).some((e) => e.type === "memory_decayed")).toBe(true);
  });

  it("apply archives long-completed tasks into a snapshot dir", () => {
    const root = project();
    const t = addTask(root, { title: "old task" });
    const done = completeTask(root, t.id);
    const now = Date.parse(done.updatedAt) + 40 * DAY;
    const report = applyDecay(root, {
      apply: true,
      now,
      config: config({ completedTaskArchiveDays: 30 }),
    });
    expect(report.actions.some((a) => a.kind === "archive_task")).toBe(true);
    expect(getTask(root, t.id)).toBeUndefined();
    expect(report.archiveDir && existsSync(join(report.archiveDir, "tasks.json"))).toBe(true);
  });

  it("apply trims the event log to the retention window", () => {
    const root = project();
    for (let i = 0; i < 8; i++) addTask(root, { title: `task ${i}` });
    const total = readEvents(root).length;
    expect(total).toBeGreaterThan(5);
    const report = applyDecay(root, { apply: true, config: config({ eventRetention: 5 }) });
    expect(report.actions.some((a) => a.kind === "trim_events")).toBe(true);
    // memory_decayed is appended after the trim, so newest 5 + 1.
    expect(readEvents(root).length).toBeLessThanOrEqual(6);
  });
});
