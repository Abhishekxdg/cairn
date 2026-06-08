import { execFileSync } from "node:child_process";
import type { SyncReport, SyncSuggestion } from "./types.js";
import { activeTasks } from "./tasks.js";
import { lockedFiles } from "./files.js";
import { appendEvent } from "./events.js";
import { withProjectLock } from "./io.js";

function git(root: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function dirtyFiles(root: string): string[] {
  return git(root, ["status", "--porcelain=v1"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .map((line) => line.split(" -> ").pop() ?? line);
}

function lastCommitFor(root: string, path: string): string {
  return git(root, ["log", "-1", "--format=%cr", "--", path]);
}

/**
 * Reconcile `.stated/` claims against git. Proposes corrections only.
 *
 * Git is truth for file/work facts, but intent facts still belong to Stated.
 * This report therefore never auto-completes tasks; it flags places where an
 * agent or human should verify, release, or complete state.
 */
export function syncProject(
  root: string,
  opts: { actor?: string } = {},
): SyncReport {
  return withProjectLock(root, () => {
    const branch =
      git(root, ["branch", "--show-current"]) || "(detached or no git)";
    const dirty = new Set(dirtyFiles(root));
    const suggestions: SyncSuggestion[] = [];

    for (const f of lockedFiles(root)) {
      if (!dirty.has(f.path) && lastCommitFor(root, f.path)) {
        const committed = lastCommitFor(root, f.path);
        suggestions.push({
          kind: "release_lock",
          target: f.path,
          reason: `locked by ${f.owner}, clean in worktree, last committed ${committed}`,
        });
      }
    }

    for (const t of activeTasks(root)) {
      const text = `${t.title} ${t.description}`.toLowerCase();
      const mentionedDirty = [...dirty].some((p) =>
        text.includes(p.toLowerCase()),
      );
      if (t.status === "active" && !mentionedDirty && dirty.size === 0) {
        suggestions.push({
          kind: "review_task",
          target: t.id,
          reason:
            "task active but worktree is clean; verify or complete if shipped",
        });
      }
    }

    appendEvent(root, "sync_ran", {
      ...(opts.actor ? { actor: opts.actor } : {}),
      data: { branch, dirtyFiles: dirty.size, suggestions: suggestions.length },
    });

    return {
      ok: suggestions.length === 0,
      branch,
      dirtyFiles: [...dirty],
      suggestions,
    };
  });
}
