import type { TasksFile } from "./types.js";
import { exists, readJson } from "./io.js";
import { statedPaths } from "./paths.js";
import { readTasks } from "./tasks.js";
import { readAgents } from "./agents.js";
import { readFiles } from "./files.js";
import { buildState } from "./snapshot.js";
import { ageLabel } from "./staleness.js";

/** Severity of a diagnostic finding. */
export type DoctorLevel = "ok" | "warn" | "error";

/** A single diagnostic result. */
export interface DoctorFinding {
  level: DoctorLevel;
  message: string;
}

export interface DoctorReport {
  healthy: boolean;
  findings: DoctorFinding[];
}

/**
 * Validate the integrity of a `.stated/` directory: presence of every file,
 * parseable JSON, and referential sanity (e.g. duplicate task ids). Read-only.
 */
export function doctor(root: string): DoctorReport {
  const paths = statedPaths(root);
  const findings: DoctorFinding[] = [];
  const ok = (m: string) => findings.push({ level: "ok", message: m });
  const warn = (m: string) => findings.push({ level: "warn", message: m });
  const error = (m: string) => findings.push({ level: "error", message: m });

  if (!exists(paths.dir)) {
    return {
      healthy: false,
      findings: [
        { level: "error", message: ".stated/ not found. Run `stated init`." },
      ],
    };
  }

  // Required files exist.
  const required: Array<[string, string]> = [
    ["project.md", paths.project],
    ["goals.md", paths.goals],
    ["tasks.json", paths.tasks],
    ["decisions.md", paths.decisions],
    ["agents.json", paths.agents],
    ["files.json", paths.files],
    ["events.jsonl", paths.events],
  ];
  for (const [label, p] of required) {
    if (exists(p)) ok(`${label} present`);
    else warn(`${label} missing (will be regenerated on next write)`);
  }

  // JSON parses.
  try {
    readJson<TasksFile>(paths.tasks, { tasks: [] });
    ok("tasks.json parses");
  } catch (e) {
    error((e as Error).message);
  }

  // Duplicate task ids.
  try {
    const tasks = readTasks(root);
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const t of tasks) {
      if (seen.has(t.id)) dupes.add(t.id);
      seen.add(t.id);
    }
    if (dupes.size) error(`Duplicate task ids: ${[...dupes].join(", ")}`);
    else ok(`${tasks.length} task(s), no duplicate ids`);
  } catch (e) {
    error((e as Error).message);
  }

  // Agents / files parse.
  try {
    const agents = readAgents(root);
    ok(`${agents.length} agent(s) registered`);
  } catch (e) {
    error((e as Error).message);
  }
  try {
    const files = readFiles(root);
    const locked = files.filter((f) => f.locked).length;
    ok(`${files.length} file record(s), ${locked} locked`);
  } catch (e) {
    error((e as Error).message);
  }

  // Derived files freshness.
  if (!exists(paths.state)) warn("state.json missing — run `stated handoff`");
  if (!exists(paths.handoff)) warn("handoff.md missing — run `stated handoff`");

  // Staleness — the rot detector. Flag any decaying fact that has gone stale so
  // a human/agent can re-verify it or let `stated decay` clean it up.
  try {
    const state = buildState(root);
    let staleCount = 0;
    for (const t of state.activeTasks) {
      if (t.confidence === "stale") {
        staleCount++;
        warn(
          `Task "${t.title}" (${t.id}) stale — verified ${ageLabel(t.ageMs)} ago. ` +
            `Run \`stated verify ${t.id}\` or update it.`,
        );
      }
    }
    for (const f of state.lockedFiles) {
      if (f.confidence === "stale") {
        staleCount++;
        warn(
          `Lock on ${f.path} (${f.owner}) stale — ${ageLabel(f.ageMs)} idle. ` +
            `Run \`stated file release ${f.path}\` or \`stated decay\`.`,
        );
      }
    }
    if (staleCount === 0) ok("No stale facts");
  } catch (e) {
    error((e as Error).message);
  }

  const healthy = !findings.some((f) => f.level === "error");
  return { healthy, findings };
}
