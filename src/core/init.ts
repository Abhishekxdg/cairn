import { basename } from "node:path";
import type { ProjectInfo } from "./types.js";
import {
  ensureDir,
  exists,
  writeJson,
  writeText,
  withProjectLock,
} from "./io.js";
import { statedPaths } from "./paths.js";
import { renderProject } from "./project.js";
import { renderGoals } from "./goals.js";
import { renderDecisions } from "./decisions.js";
import { detectFrameworks } from "./framework.js";
import { appendEvent } from "./events.js";
import { regenerate } from "./snapshot.js";

export interface InitOptions {
  /** Project name. Defaults to the directory name. */
  name?: string;
  description?: string;
  /** Overwrite an existing `.stated/` instead of erroring. */
  force?: boolean;
}

export interface InitResult {
  root: string;
  created: boolean;
  frameworks: string[];
}

/**
 * Initialize a `.stated/` shared-state directory in `root`.
 *
 * Creates every canonical file with sensible, empty-but-valid contents, detects
 * the framework, and generates the first snapshot. Idempotent-ish: refuses to
 * clobber an existing directory unless `force` is passed.
 */
export function init(root: string, options: InitOptions = {}): InitResult {
  return withProjectLock(root, () => {
    const paths = statedPaths(root);

    if (exists(paths.dir) && !options.force) {
      throw new Error(
        `${paths.dir} already exists. Pass force to reinitialize (this overwrites scaffolding, not your data).`,
      );
    }

    ensureDir(paths.dir);
    ensureDir(paths.snapshots);

    const frameworks = detectFrameworks(root);
    const project: ProjectInfo = {
      name: options.name?.trim() || basename(root),
      description: options.description?.trim() ?? "",
      architecture: frameworks.length ? frameworks.join(", ") : "",
      currentStatus: "Just initialized with Stated.",
    };

    // Only scaffold files that don't already exist so `force` re-init preserves
    // human-authored content where possible.
    if (!exists(paths.project) || options.force) {
      writeText(paths.project, renderProject(project));
    }
    if (!exists(paths.goals) || options.force) {
      writeText(paths.goals, renderGoals({ active: [], completed: [] }));
    }
    if (!exists(paths.tasks) || options.force) {
      writeJson(paths.tasks, { tasks: [] });
    }
    if (!exists(paths.decisions) || options.force) {
      writeText(paths.decisions, renderDecisions([]));
    }
    if (!exists(paths.agents) || options.force) {
      writeJson(paths.agents, []);
    }
    if (!exists(paths.files) || options.force) {
      writeJson(paths.files, []);
    }
    if (!exists(paths.events) || options.force) {
      writeText(paths.events, "");
    }
    if (!exists(paths.gitignore) || options.force) {
      writeText(paths.gitignore, "state.json\nhandoff.md\n*.lock\n");
    }

    writeText(paths.snapshots + "/.gitkeep", "");

    appendEvent(root, "initialized", {
      data: { name: project.name, frameworks },
    });
    regenerate(root);

    return { root, created: true, frameworks };
  });
}
