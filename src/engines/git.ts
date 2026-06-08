import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Git integration — coexist with Git without fighting it.
 *
 * Reads `.git` directly (no `git` binary dependency) to correlate journal
 * activity with the repository: current branch and commit. The journal lives
 * inside the repo but its derived/optimization files are git-ignored, so it
 * never produces merge-conflict-heavy generated artifacts.
 */

export interface GitInfo {
  isRepo: boolean;
  gitDir: string | null;
  branch: string | null;
  commit: string | null;
}

/** Find the `.git` directory walking up from `start`. */
function findGitDir(start: string): string | null {
  let current = start;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = join(current, ".git");
    if (existsSync(candidate)) return candidate;
    const parent = join(current, "..");
    if (parent === current) return null;
    current = parent;
  }
}

/** Detect git state for a project root. Best-effort, never throws. */
export function detectGit(root: string): GitInfo {
  try {
    const gitDir = findGitDir(root);
    if (!gitDir) return { isRepo: false, gitDir: null, branch: null, commit: null };

    // `.git` may be a file (worktrees/submodules: "gitdir: <path>").
    let dir = gitDir;
    try {
      const stat = readFileSync(gitDir, "utf8");
      const m = stat.match(/^gitdir:\s*(.+)\s*$/);
      if (m && m[1]) dir = m[1];
    } catch {
      // It's a directory, not a file — normal case.
    }

    const headPath = join(dir, "HEAD");
    if (!existsSync(headPath)) {
      return { isRepo: true, gitDir: dir, branch: null, commit: null };
    }
    const head = readFileSync(headPath, "utf8").trim();
    const ref = head.match(/^ref:\s*(.+)$/);
    if (ref && ref[1]) {
      const branch = ref[1].replace(/^refs\/heads\//, "");
      const refPath = join(dir, ref[1]);
      const commit = existsSync(refPath)
        ? readFileSync(refPath, "utf8").trim()
        : packedRef(dir, ref[1]);
      return { isRepo: true, gitDir: dir, branch, commit };
    }
    // Detached HEAD — the HEAD file is the commit hash itself.
    return { isRepo: true, gitDir: dir, branch: null, commit: head };
  } catch {
    return { isRepo: false, gitDir: null, branch: null, commit: null };
  }
}

/** Resolve a ref from packed-refs when no loose ref file exists. */
function packedRef(gitDir: string, ref: string): string | null {
  const packed = join(gitDir, "packed-refs");
  if (!existsSync(packed)) return null;
  for (const line of readFileSync(packed, "utf8").split("\n")) {
    const m = line.match(/^([0-9a-f]{40})\s+(.+)$/);
    if (m && m[2] === ref) return m[1] ?? null;
  }
  return null;
}

/** Build a payload fragment correlating an event to the current git state. */
export function gitCorrelation(root: string): Record<string, string> {
  const g = detectGit(root);
  const out: Record<string, string> = {};
  if (g.branch) out["gitBranch"] = g.branch;
  if (g.commit) out["gitCommit"] = g.commit;
  return out;
}
