import { execFileSync } from "node:child_process";
import type { EventStore } from "../core/store.js";
import type { NewEvent } from "../core/types.js";
import { detectGit } from "./git.js";

/**
 * Git auto-capture — derive file events from git history with ZERO agent effort.
 *
 * The hardest problem in any agent-memory system is getting accurate data in.
 * Instead of asking agents to hand-narrate every file they touch (which they
 * forget, and which duplicates git), AJP reads git itself: each new commit
 * becomes `file.created` / `file.modified` / `file.deleted` events plus a
 * `git.commit` record, attributed to the commit author. Agents only record
 * *intent* git can't know (goals, decisions, knowledge, task lifecycle).
 *
 * Deterministic + idempotent: every derived event has a stable id built from the
 * commit sha (+ path), so re-running sync never duplicates. Best-effort — a
 * no-op outside a git repo or when the `git` binary is unavailable.
 */

const SEP = "\x1f";
const META_LAST = "git_last_commit";

function git(root: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
  }).toString();
}

export interface GitSyncResult {
  synced: boolean;
  commits: number;
  events: number;
  fromCommit: string | null;
  toCommit: string | null;
}

interface CommitMeta {
  sha: string;
  author: string;
  date: string;
  message: string;
}

/** Parse `--name-status` output into file change events for one commit. */
function fileEventsForCommit(
  root: string,
  c: CommitMeta,
  branch: string | null,
): NewEvent[] {
  const raw = git(root, [
    "show",
    "--name-status",
    "--no-renames",
    "--pretty=format:",
    "--no-color",
    c.sha,
  ]).trim();

  const events: NewEvent[] = [];
  for (const line of raw.split("\n")) {
    const parts = line.trim().split("\t");
    if (parts.length < 2) continue;
    const status = parts[0]!.charAt(0);
    const path = parts[parts.length - 1]!;
    const type =
      status === "A" ? "file.created" : status === "D" ? "file.deleted" : "file.modified";
    events.push({
      type,
      id: `gitfile:${c.sha}:${path}`,
      actor: c.author,
      timestamp: c.date,
      payload: {
        path,
        owner: c.author,
        commit: c.sha,
        ...(branch ? { gitBranch: branch } : {}),
        source: "git",
      },
    });
  }
  return events;
}

/**
 * Sync git history into the journal.
 *
 * @param opts.full  On the FIRST sync, capture the entire history. Default is to
 *   set a baseline at HEAD and capture only commits made afterward — so day-one
 *   sync doesn't dump a huge repo's whole past into the journal.
 */
export function syncGit(
  store: EventStore,
  root: string,
  opts: { full?: boolean } = {},
): GitSyncResult {
  const info = detectGit(root);
  if (!info.isRepo) {
    return { synced: false, commits: 0, events: 0, fromCommit: null, toCommit: null };
  }

  let head: string;
  try {
    head = git(root, ["rev-parse", "HEAD"]).trim();
  } catch {
    // Repo with no commits yet.
    return { synced: true, commits: 0, events: 0, fromCommit: null, toCommit: null };
  }

  const last = store.getMeta(META_LAST) ?? null;

  // First-ever sync without --full: record the baseline, capture nothing.
  if (!last && !opts.full) {
    store.setMeta(META_LAST, head);
    return { synced: true, commits: 0, events: 0, fromCommit: null, toCommit: head };
  }
  if (last === head) {
    return { synced: true, commits: 0, events: 0, fromCommit: last, toCommit: head };
  }

  const range = last ? `${last}..HEAD` : "HEAD";
  let log: string;
  try {
    log = git(root, [
      "log",
      "--reverse",
      "--no-merges",
      `--pretty=format:%H${SEP}%an${SEP}%aI${SEP}%s`,
      range,
    ]).trim();
  } catch {
    return { synced: false, commits: 0, events: 0, fromCommit: last, toCommit: head };
  }

  const commits: CommitMeta[] = log
    ? log.split("\n").map((l) => {
        const [sha, author, date, message] = l.split(SEP);
        return { sha: sha!, author: author ?? "", date: date ?? "", message: message ?? "" };
      })
    : [];

  const events: NewEvent[] = [];
  for (const c of commits) {
    events.push({
      type: "git.commit",
      id: `gitcommit:${c.sha}`,
      actor: c.author,
      timestamp: c.date,
      payload: {
        commit: c.sha,
        message: c.message,
        author: c.author,
        ...(info.branch ? { gitBranch: info.branch } : {}),
      },
    });
    events.push(...fileEventsForCommit(root, c, info.branch));
  }

  if (events.length) store.batchAppend(events);
  store.setMeta(META_LAST, head);

  return {
    synced: true,
    commits: commits.length,
    events: events.length,
    fromCommit: last,
    toCommit: head,
  };
}
