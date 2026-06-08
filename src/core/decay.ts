import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Task, StatedEvent } from "./types.js";
import {
  ensureDir,
  writeJson,
  writeText,
  appendLine,
  withProjectLock,
} from "./io.js";
import { statedPaths } from "./paths.js";
import { nowIso } from "./ids.js";
import { loadConfig, type StatedConfig } from "./config.js";
import { readTasks, writeTasks } from "./tasks.js";
import { readFiles, writeFiles } from "./files.js";
import { readEvents, appendEvent } from "./events.js";
import { fileVerifiedAt, ageMsOf } from "./staleness.js";
import { regenerate } from "./snapshot.js";

/**
 * Customizable memory decay.
 *
 * Where the staleness signal makes facts *look* old, decay actually *cleans
 * them up* — releasing abandoned locks, archiving long-completed tasks, and
 * trimming the event log. It is strictly opt-in: every policy defaults to `0`
 * (off), and even when enabled it only runs when explicitly invoked
 * (`stated decay` / the `run_decay` MCP tool), never silently on a write.
 */

/** A single decay action (proposed in dry-run, performed when applied). */
export interface DecayAction {
  kind: "release_lock" | "archive_task" | "trim_events";
  /** What the action targets (a file path, task id, or "events"). */
  target: string;
  /** Human-readable explanation. */
  detail: string;
}

/** The result of a decay pass. */
export interface DecayReport {
  /** Whether the actions were actually performed (`false` = dry run). */
  applied: boolean;
  actions: DecayAction[];
  /** Directory the archived data was written to, if any. */
  archiveDir: string | null;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Overwrite the JSONL event log atomically with the given events. */
function writeEvents(path: string, events: StatedEvent[]): void {
  const body = events.map((e) => JSON.stringify(e)).join("\n");
  writeText(path, body ? body + "\n" : "");
}

function hashEvents(events: StatedEvent[]): string {
  const hash = createHash("sha256");
  for (const ev of events) hash.update(JSON.stringify(ev) + "\n");
  return hash.digest("hex");
}

/**
 * Compute (and optionally apply) the decay actions for a project.
 *
 * @param opts.apply  When true, perform the mutations. Default false (dry run).
 * @param opts.now    Injectable clock (ms) for deterministic behavior/tests.
 */
export function applyDecay(
  root: string,
  opts: { apply?: boolean; now?: number; config?: StatedConfig } = {},
): DecayReport {
  return withProjectLock(root, () => {
    const apply = opts.apply ?? false;
    const now = opts.now ?? Date.now();
    const config = opts.config ?? loadConfig(root);
    const policy = config.decay;
    const paths = statedPaths(root);

    const actions: DecayAction[] = [];
    let archiveDir: string | null = null;
    const ensureArchive = (): string => {
      if (!archiveDir) {
        archiveDir = join(
          paths.snapshots,
          `archive-${nowIso().replace(/[:.]/g, "-")}`,
        );
        ensureDir(archiveDir);
      }
      return archiveDir;
    };

    // --- 1. Auto-release abandoned locks --------------------------------------
    if (policy.lockAutoReleaseHours > 0) {
      const cutoff = policy.lockAutoReleaseHours * HOUR_MS;
      const files = readFiles(root);
      const kept = files.filter((f) => {
        if (!f.locked) return true;
        const age = ageMsOf(fileVerifiedAt(f), now);
        if (age < cutoff) return true;
        actions.push({
          kind: "release_lock",
          target: f.path,
          detail: `lock by ${f.owner} idle ${Math.floor(age / HOUR_MS)}h ≥ ${policy.lockAutoReleaseHours}h`,
        });
        return false;
      });
      if (apply && kept.length !== files.length) writeFiles(root, kept);
    }

    // --- 2. Archive long-completed tasks --------------------------------------
    if (policy.completedTaskArchiveDays > 0) {
      const cutoff = policy.completedTaskArchiveDays * DAY_MS;
      const tasks = readTasks(root);
      const toArchive: Task[] = [];
      const kept = tasks.filter((t) => {
        if (t.status !== "completed") return true;
        const age = ageMsOf(t.updatedAt, now);
        if (age < cutoff) return true;
        toArchive.push(t);
        actions.push({
          kind: "archive_task",
          target: t.id,
          detail: `completed ${Math.floor(age / DAY_MS)}d ago ≥ ${policy.completedTaskArchiveDays}d`,
        });
        return false;
      });
      if (apply && toArchive.length) {
        const dir = ensureArchive();
        writeJson(join(dir, "tasks.json"), { tasks: toArchive });
        writeTasks(root, kept);
      }
    }

    // --- 3. Trim the event log ------------------------------------------------
    if (policy.eventRetention > 0) {
      const events = readEvents(root);
      if (events.length > policy.eventRetention) {
        const drop = events.length - policy.eventRetention;
        actions.push({
          kind: "trim_events",
          target: "events",
          detail: `archive ${drop} of ${events.length} events, keep newest ${policy.eventRetention}`,
        });
        if (apply) {
          const dir = ensureArchive();
          const archived = events.slice(0, drop);
          const retained = events.slice(drop);
          for (const ev of events.slice(0, drop)) {
            appendLine(join(dir, "events.jsonl"), JSON.stringify(ev));
          }
          writeJson(join(dir, "manifest.json"), {
            kind: "event-archive",
            createdAt: nowIso(),
            totalEvents: events.length,
            archivedEvents: archived.length,
            retainedEvents: retained.length,
            firstArchivedAt: archived[0]?.at ?? null,
            lastArchivedAt: archived[archived.length - 1]?.at ?? null,
            archivedSha256: hashEvents(archived),
            retainedSha256: hashEvents(retained),
          });
          writeEvents(paths.events, retained);
        }
      }
    }

    if (apply && actions.length) {
      appendEvent(root, "memory_decayed", {
        data: { actions: actions.length, archiveDir },
      });
      regenerate(root);
    }

    return { applied: apply, actions, archiveDir };
  });
}
