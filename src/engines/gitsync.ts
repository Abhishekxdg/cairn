import { execFileSync } from "node:child_process";
import type { EventStore } from "../core/store.js";
import type { NewEvent } from "../core/types.js";
import { detectGit } from "./git.js";

/**
 * Git auto-capture — derive file events from git history with ZERO agent effort.
 *
 * The hardest problem in any agent-memory system is getting accurate data in.
 * Instead of asking agents to hand-narrate every file they touch (which they
 * forget, and which duplicates git), Cairn reads git itself: each new commit
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

/**
 * Freshness signal: how many commits git HEAD is ahead of what the journal last
 * captured. 0 means CONTEXT.md is current; >0 means commits landed without a
 * sync (so the recalled context may be stale). Best-effort — returns 0 if git is
 * unavailable or the journal has no baseline yet.
 */
export function gitDrift(store: EventStore, root: string): number {
  try {
    if (!detectGit(root).isRepo) return 0;
    const last = store.getMeta(META_LAST) ?? null;
    if (!last) return 0;
    const head = git(root, ["rev-parse", "HEAD"]).trim();
    if (!head || head === last) return 0;
    const n = git(root, ["rev-list", "--count", `${last}..HEAD`]).trim();
    return Number.parseInt(n, 10) || 0;
  } catch {
    return 0;
  }
}

export interface GitSyncResult {
  synced: boolean;
  commits: number;
  events: number;
  /** Decisions auto-extracted from commit messages. */
  decisions: number;
  fromCommit: string | null;
  toCommit: string | null;
}

/** Verbs that signal a durable decision in a commit subject. */
const DECISION_RE =
  /\b(use|using|adopt|adopted|switch to|switched to|migrate to|migrated to|move to|moved to|replace[d]? .+ with|go with|went with|standardi[sz]e on|chose|choose|decided to)\b/i;

/**
 * Extract durable DECISIONS from a commit message — the intent git can't infer
 * from a diff. Two precisions:
 *   - structured: body lines `Decision: …` (+ optional `Reason:/Why:/Because:`)
 *   - heuristic:  a subject whose verb signals a decision (use/adopt/switch…)
 * Returns proposed `decision.made` events, tagged + idempotent by commit sha.
 */
export function extractIntent(root: string, c: CommitMeta): NewEvent[] {
  let body = "";
  try {
    body = git(root, ["log", "-1", "--format=%B", c.sha]).trim();
  } catch {
    body = c.message;
  }
  const lines = body.split("\n");
  const events: NewEvent[] = [];
  const decision = (
    decId: string,
    title: string,
    rationale: string,
    confidence: string,
  ): NewEvent => ({
    type: "decision.made",
    id: decId,
    actor: c.author,
    timestamp: c.date,
    payload: {
      id: decId,
      title,
      rationale,
      madeBy: c.author,
      commit: c.sha,
      source: "git-extracted",
      confidence,
    },
  });

  // 1. Structured `Decision:` / `Reason:` lines (high precision).
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^\s*decision:\s*(.+\S)\s*$/i);
    if (!m) continue;
    let reason = "";
    for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
      const r = lines[j]!.match(/^\s*(?:reason|why|because):\s*(.+\S)\s*$/i);
      if (r) { reason = r[1]!; break; }
    }
    events.push(decision(`gitdecision:${c.sha}:${n}`, m[1]!, reason, "structured"));
    n++;
  }
  if (n > 0) return events; // structured wins; don't double-count the subject

  // 2. Heuristic: a subject whose verb signals a decision.
  const subject = (lines[0] ?? c.message).replace(/^\w+(\([^)]+\))?:\s*/, "").trim();
  if (DECISION_RE.test(subject)) {
    events.push(
      decision(
        `gitdecision:${c.sha}`,
        subject.charAt(0).toUpperCase() + subject.slice(1),
        `from commit ${c.sha.slice(0, 7)}`,
        "heuristic",
      ),
    );
  }
  return events;
}

interface CommitMeta {
  sha: string;
  author: string;
  date: string;
  message: string;
}

/** Paths inside the journal itself — never recorded as file events. */
function isJournalPath(path: string): boolean {
  return path === ".agent" || path.startsWith(".agent/");
}

/**
 * Parse `--name-status` output into file change events for one commit.
 * Returns the events plus the total number of changed paths, so the caller can
 * tell a journal-only commit (changed > 0, events empty) from an empty commit.
 */
function fileEventsForCommit(
  root: string,
  c: CommitMeta,
  branch: string | null,
): { events: NewEvent[]; changed: number } {
  const raw = git(root, [
    "show",
    "--name-status",
    "--no-renames",
    "--pretty=format:",
    "--no-color",
    c.sha,
  ]).trim();

  const events: NewEvent[] = [];
  let changed = 0;
  for (const line of raw.split("\n")) {
    const parts = line.trim().split("\t");
    if (parts.length < 2) continue;
    changed++;
    const status = parts[0]!.charAt(0);
    const path = parts[parts.length - 1]!;
    if (isJournalPath(path)) continue; // never journal the journal itself
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
  return { events, changed };
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
  opts: { full?: boolean; extractIntent?: boolean } = {},
): GitSyncResult {
  const extract = opts.extractIntent !== false;
  const info = detectGit(root);
  if (!info.isRepo) {
    return { synced: false, commits: 0, events: 0, decisions: 0, fromCommit: null, toCommit: null };
  }

  let head: string;
  try {
    head = git(root, ["rev-parse", "HEAD"]).trim();
  } catch {
    // Repo with no commits yet.
    return { synced: true, commits: 0, events: 0, decisions: 0, fromCommit: null, toCommit: null };
  }

  const last = store.getMeta(META_LAST) ?? null;

  // First-ever sync without --full: record the baseline, capture nothing.
  if (!last && !opts.full) {
    store.setMeta(META_LAST, head);
    return { synced: true, commits: 0, events: 0, decisions: 0, fromCommit: null, toCommit: head };
  }
  if (last === head) {
    return { synced: true, commits: 0, events: 0, decisions: 0, fromCommit: last, toCommit: head };
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
    return { synced: false, commits: 0, events: 0, decisions: 0, fromCommit: last, toCommit: head };
  }

  const commits: CommitMeta[] = log
    ? log.split("\n").map((l) => {
        const [sha, author, date, message] = l.split(SEP);
        return { sha: sha!, author: author ?? "", date: date ?? "", message: message ?? "" };
      })
    : [];

  const events: NewEvent[] = [];
  let decisions = 0;
  for (const c of commits) {
    const { events: fileEvents, changed } = fileEventsForCommit(root, c, info.branch);
    // Skip commits that touch ONLY the journal (e.g. the auto-sync follow-up
    // commit) — recording them would be self-referential noise.
    if (changed > 0 && fileEvents.length === 0) continue;
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
    events.push(...fileEvents);
    if (extract) {
      const intent = extractIntent(root, c);
      decisions += intent.length;
      events.push(...intent);
    }
  }

  if (events.length) store.batchAppend(events);
  store.setMeta(META_LAST, head);

  return {
    synced: true,
    commits: commits.length,
    events: events.length,
    decisions,
    fromCommit: last,
    toCommit: head,
  };
}

export interface WorkingSyncResult {
  synced: boolean;
  /** Number of uncommitted paths seen in the working tree. */
  changed: number;
  /** Number of NEW provisional events appended (idempotent per path). */
  events: number;
}

/**
 * Capture UNCOMMITTED work as provisional file events.
 *
 * {@link syncGit} only sees committed history, so an agent that edits files but
 * never commits leaves no file-memory behind — the next session is blind to the
 * in-flight work. This reads `git status` and emits `file.*` events tagged
 * `source: "working"` with a path-stable id (`gitworking:<path>`), so they:
 *   - persist to `events.jsonl` immediately (no commit required), and
 *   - are naturally superseded once the real commit lands and `syncGit` appends
 *     the authoritative `gitfile:<sha>:<path>` event for the same path.
 *
 * Idempotent: re-running on the same dirty set appends nothing new (INSERT OR
 * IGNORE on the path-keyed id). Best-effort — a no-op outside a git repo.
 */
export function syncWorking(store: EventStore, root: string): WorkingSyncResult {
  const info = detectGit(root);
  if (!info.isRepo) return { synced: false, changed: 0, events: 0 };

  let raw: string;
  try {
    raw = git(root, ["-c", "core.quotepath=false", "status", "--porcelain", "--untracked-files=all"]);
  } catch {
    return { synced: false, changed: 0, events: 0 };
  }

  const branch = info.branch;
  const now = new Date().toISOString();
  const events: NewEvent[] = [];
  let changed = 0;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const xy = line.slice(0, 2);
    let path = line.slice(3);
    // Renames/copies render as "old -> new"; the new path is what exists now.
    const arrow = path.indexOf(" -> ");
    if (arrow !== -1) path = path.slice(arrow + 4);
    // Paths with special chars are wrapped in double quotes.
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
    if (isJournalPath(path)) continue; // never journal the journal itself

    // Prefer the staged (index) status char, falling back to the worktree char.
    const status = xy === "??" ? "A" : (xy.trim().charAt(0) || "M");
    const type =
      status === "D" ? "file.deleted" : status === "A" ? "file.created" : "file.modified";
    changed++;
    events.push({
      type,
      id: `gitworking:${path}`,
      actor: "working-tree",
      timestamp: now,
      payload: {
        path,
        ...(branch ? { gitBranch: branch } : {}),
        source: "working",
      },
    });
  }

  // Report NEWLY-inserted events, not built ones: the path-keyed id dedupes via
  // INSERT OR IGNORE, so a re-run on the same dirty set inserts nothing.
  const before = store.count();
  if (events.length) store.batchAppend(events);
  return { synced: true, changed, events: store.count() - before };
}
