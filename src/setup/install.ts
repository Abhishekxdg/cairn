import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isInitialized, findRoot, agentPaths } from "../core/paths.js";
import { init } from "../core/manifest.js";
import { EventStore } from "../core/store.js";
import { detectGit } from "../engines/git.js";
import { syncGit } from "../engines/gitsync.js";
import { writeContextFile } from "../engines/recall.js";
import { indexRepo } from "../engines/codegraph.js";
import {
  BEGIN_MARKER,
  END_MARKER,
  rulesBlock,
  upsertBetween,
  RULES_VERSION,
  parseRulesVersion,
} from "./rules.js";

/**
 * Classify a project for setup, so postinstall can decide whether to wire Cairn
 * silently or ask first:
 *   - "initialized": already has an `.agent/` journal — consent is implied; a
 *     re-install just refreshes idempotently, never re-prompts.
 *   - "existing": a git repo that already has commits (real prior history). Auto-
 *     wiring this is surprising, so postinstall asks before touching it.
 *   - "new": a fresh/empty dir or a commit-less repo — nothing to disturb, wire
 *     silently.
 * Reads `.git` directly (no `git` binary), so it works in any environment.
 */
export type RepoKind = "initialized" | "existing" | "new";

export function classifyRepo(root: string): RepoKind {
  if (isInitialized(root)) return "initialized";
  const info = detectGit(root);
  // A repo with at least one commit = existing history worth asking about.
  if (info.isRepo && info.commit) return "existing";
  return "new";
}

/** Absolute path to this package's `cairn` CLI entry (dist/setup → ../../bin). */
const CAIRN_BIN = resolve(dirname(fileURLToPath(import.meta.url)), "../../bin/cairn.js");

/**
 * A robust `cairn` invocation that works even when `cairn` isn't on PATH: prefer the
 * PATH command, fall back to running this package's binary with node.
 */
export function cairnInvocation(): string {
  return `node ${CAIRN_BIN}`;
}

const HOOK_BEGIN = "# CAIRN:BEGIN auto-capture";
const HOOK_END = "# CAIRN:END";
// The hook: (1) capture the commit into the journal (`cairn sync`), then
// (2) commit the journal updates that sync produced into a follow-up commit, so
// the memory of a commit lands in git instead of dangling as a dirty worktree.
// Recursion is impossible: the follow-up commit runs with CAIRN_SKIP_HOOK=1, so
// its own post-commit hook is a no-op. Opt out of the auto-commit with
// CAIRN_NO_AUTOCOMMIT=1 (sync still runs). Never touches an in-progress
// merge/rebase, and only ever commits paths under `.agent/`.
const HOOK_BODY = `${HOOK_BEGIN}
if [ -z "$CAIRN_SKIP_HOOK" ]; then
  if command -v cairn >/dev/null 2>&1; then cairn sync >/dev/null 2>&1 || true
  elif [ -f "${CAIRN_BIN}" ]; then node "${CAIRN_BIN}" sync >/dev/null 2>&1 || true
  fi
  if [ -z "$CAIRN_NO_AUTOCOMMIT" ]; then
    _cairn_gd=$(git rev-parse --git-dir 2>/dev/null) || _cairn_gd=""
    if [ -n "$_cairn_gd" ] && [ ! -e "$_cairn_gd/MERGE_HEAD" ] && [ ! -d "$_cairn_gd/rebase-merge" ] && [ ! -d "$_cairn_gd/rebase-apply" ]; then
      if ! git diff --quiet -- .agent 2>/dev/null || git ls-files --others --exclude-standard -- .agent 2>/dev/null | grep -q .; then
        CAIRN_SKIP_HOOK=1 git add -- .agent >/dev/null 2>&1 || true
        CAIRN_SKIP_HOOK=1 git commit -q --no-verify -m "chore(cairn): sync journal" -- .agent >/dev/null 2>&1 || true
      fi
    fi
  fi
fi
${HOOK_END}`;

/**
 * Resolve the git hooks directory, honoring `core.hooksPath` (Husky, Lefthook,
 * many monorepos). Writing to `$GIT_DIR/hooks` when `core.hooksPath` is set would
 * install a hook git never runs — a silent failure of auto-capture. Falls back to
 * `$GIT_DIR/hooks` when the setting is absent or `git` is unavailable.
 */
function resolveHooksDir(root: string, gitDir: string): string {
  try {
    const custom = execFileSync("git", ["-C", root, "config", "--get", "core.hooksPath"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (custom) return resolve(root, custom);
  } catch {
    // not set, or git binary unavailable — use the default hooks dir.
  }
  return join(gitDir, "hooks");
}

/**
 * Install a git `post-commit` hook that runs `cairn sync`, so every commit is
 * auto-captured into the journal with zero agent effort. Idempotent; preserves
 * any existing hook content. Returns true if a repo hook was written.
 */
export function installGitHook(root: string): boolean {
  const info = detectGit(root);
  if (!info.isRepo || !info.gitDir) return false;
  const hooksDir = resolveHooksDir(root, info.gitDir);
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, "post-commit");

  let existing = existsSync(hookPath) ? readFileSync(hookPath, "utf8") : "";
  if (!existing.trim()) existing = "#!/bin/sh\n";
  if (existing.includes(HOOK_BEGIN)) {
    const re = new RegExp(`${HOOK_BEGIN}[\\s\\S]*?${HOOK_END}`);
    existing = existing.replace(re, HOOK_BODY);
  } else {
    existing = existing.trimEnd() + "\n\n" + HOOK_BODY + "\n";
  }
  writeFileSync(hookPath, existing);
  try {
    chmodSync(hookPath, 0o755);
  } catch {
    // chmod may fail on some filesystems; the hook still works if executable.
  }
  return true;
}

/**
 * Marker embedded in the SessionStart hook command so re-running setup updates
 * the same hook in place instead of stacking duplicates.
 */
const SESSION_HOOK_MARKER = "CAIRN:recall-inject";

/**
 * Auto-recall: install a Claude Code SessionStart hook that injects CONTEXT.md
 * into every new session. Recall must be INVOLUNTARY — the whole token saving
 * only happens if the agent reads CONTEXT.md without being told, in every tool.
 * The git rules cover Claude's CLAUDE.md bootstrap, but a SessionStart hook makes
 * it fire deterministically. The hook's stdout becomes the session's context.
 *
 * Merges into `.claude/settings.json`, preserving existing settings and other
 * hooks. Idempotent via SESSION_HOOK_MARKER. Returns true if written.
 */
export function installSessionHook(root: string): boolean {
  const dir = join(root, ".claude");
  const file = join(dir, "settings.json");
  // The command prints CONTEXT.md if present; the marker makes it self-identifying.
  const command = `# ${SESSION_HOOK_MARKER}\n[ -f "${join(root, ".agent", "CONTEXT.md")}" ] && cat "${join(root, ".agent", "CONTEXT.md")}" || true`;

  let settings: any = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, "utf8")) || {};
    } catch {
      return false; // don't clobber a settings file we can't parse
    }
  }
  settings.hooks = settings.hooks ?? {};
  const list: any[] = Array.isArray(settings.hooks.SessionStart)
    ? settings.hooks.SessionStart
    : [];
  // Drop any prior Cairn entry, then add a fresh one.
  const cleaned = list.filter(
    (g) =>
      !(
        g &&
        Array.isArray(g.hooks) &&
        g.hooks.some((h: any) => typeof h?.command === "string" && h.command.includes(SESSION_HOOK_MARKER))
      ),
  );
  cleaned.push({ hooks: [{ type: "command", command }] });
  settings.hooks.SessionStart = cleaned;

  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  return true;
}

/**
 * Project setup — the one-shot that makes Cairn "just work" for every coding agent
 * without MCP.
 *
 * It (1) creates the `.agent/` journal if missing, and (2) injects the Cairn usage
 * rules into the instruction files each agent already reads automatically
 * (CLAUDE.md, AGENTS.md, .cursorrules, GEMINI.md, Copilot instructions). After
 * this, any agent opening the repo is taught how and when to use the journal.
 *
 * Idempotent: re-running updates the managed block in place between markers and
 * never touches the human-written parts of those files.
 */

/**
 * Instruction files that coding agents read automatically. `primary` files are
 * created on setup even if absent (they're the universal ones); the rest are
 * only updated when they already exist, to stay unobtrusive.
 */
export const AGENT_FILES: Array<{ path: string; agent: string; primary: boolean }> = [
  { path: "AGENTS.md", agent: "Codex / OpenHands / generic", primary: true },
  { path: "CLAUDE.md", agent: "Claude Code", primary: true },
  { path: "GEMINI.md", agent: "Gemini CLI", primary: false },
  { path: ".cursorrules", agent: "Cursor", primary: false },
  { path: ".github/copilot-instructions.md", agent: "GitHub Copilot", primary: false },
];

export interface SetupResult {
  root: string;
  initializedJournal: boolean;
  filesCreated: string[];
  filesUpdated: string[];
  /** Whether a git post-commit auto-capture hook was installed. */
  gitHook: boolean;
  /** Whether a Claude Code SessionStart auto-recall hook was installed. */
  sessionHook: boolean;
  /** Number of source files indexed into the static code graph (0 if skipped). */
  filesIndexed: number;
}

/**
 * Insert or update the Cairn block in a single file's content. Returns the new
 * content and whether the file already had a block.
 */
export function upsertBlock(
  existing: string,
  cairnBin = "cairn",
): { content: string; updated: boolean } {
  return upsertBetween(existing, BEGIN_MARKER, END_MARKER, rulesBlock(cairnBin));
}

/**
 * Set up Cairn in a project: create the journal and inject agent rules.
 *
 * @param root  Project root.
 * @param opts.all  Create every known agent file, not just the primary ones.
 * @param opts.gitHook  Set false to skip installing the git auto-capture hook.
 * @param opts.buildIndex  Build the static code graph now (so `cairn relevant`
 *   works on the existing codebase immediately). Off by default — callers that
 *   want it on an existing repo (consented postinstall, `cairn setup`) opt in.
 */
export function setupProject(
  root: string,
  opts: { all?: boolean; gitHook?: boolean; sessionHook?: boolean; buildIndex?: boolean } = {},
): SetupResult {
  const filesCreated: string[] = [];
  const filesUpdated: string[] = [];
  // Embed a PATH-independent invocation in the rules so agents always reach cairn.
  const cairnBin = cairnInvocation();

  // 1. Ensure the journal exists.
  let initializedJournal = false;
  if (!isInitialized(root)) {
    init(root);
    initializedJournal = true;
  }

  // 2. Inject rules into each agent instruction file. Primary files are created
  //    if absent; secondary files are only updated when they already exist
  //    (unless `all`), so we don't litter the repo with empty configs.
  for (const { path, primary } of AGENT_FILES) {
    const full = join(root, path);
    const exists = existsSync(full);
    if (!exists && !primary && !opts.all) continue;

    const existing = exists ? readFileSync(full, "utf8") : "";
    const { content, updated } = upsertBlock(existing, cairnBin);
    if (exists && updated && content === existing) continue; // nothing changed

    if (!exists) mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    if (exists) filesUpdated.push(path);
    else filesCreated.push(path);
  }

  // 3. Wire git auto-capture: install the post-commit hook + set the sync
  //    baseline so future commits flow into the journal with no agent effort.
  let gitHook = false;
  let filesIndexed = 0;
  {
    const store = new EventStore(agentPaths(root).db);
    try {
      if (opts.gitHook !== false) {
        gitHook = installGitHook(root);
        if (gitHook) syncGit(store, root); // baseline or capture
      }
      // 3b. Build the static code graph now if asked, so "task → files"
      //     (`cairn relevant`) works on an existing codebase from the first
      //     query, before any post-install commit history exists. Best-effort:
      //     a graph failure must never break setup.
      if (opts.buildIndex) {
        try {
          const idx = indexRepo(root, { actor: "cairn" });
          if (idx.events.length) store.batchAppend(idx.events);
          filesIndexed = idx.files;
        } catch {
          /* indexing is best-effort; never block setup */
        }
      }
      // 4. Render the instant-recall file so a new agent is oriented by one read.
      writeContextFile(store, root);
    } finally {
      store.close();
    }
  }

  // 5. Auto-recall: install the SessionStart hook so CONTEXT.md is injected into
  //    every Claude Code session without the agent having to ask for it.
  let sessionHook = false;
  if (opts.sessionHook !== false) {
    sessionHook = installSessionHook(root);
  }

  return {
    root: findRoot(root) ?? root,
    initializedJournal,
    filesCreated,
    filesUpdated,
    gitHook,
    sessionHook,
    filesIndexed,
  };
}

/**
 * Self-healing rules: rewrite any agent file whose managed Cairn block is older
 * than the current `RULES_VERSION` (or unstamped). Only touches files that
 * already have a block — never creates new files, never installs hooks. Cheap
 * and idempotent, so it's safe to call on every `sync`. Returns the paths it
 * refreshed.
 */
export function refreshProjectRules(root: string): string[] {
  const cairnBin = cairnInvocation();
  const refreshed: string[] = [];
  for (const { path } of AGENT_FILES) {
    const full = join(root, path);
    if (!existsSync(full)) continue;
    const existing = readFileSync(full, "utf8");
    if (!existing.includes(BEGIN_MARKER)) continue; // not managed here
    if (parseRulesVersion(existing) >= RULES_VERSION) continue; // already current
    const { content } = upsertBetween(existing, BEGIN_MARKER, END_MARKER, rulesBlock(cairnBin));
    if (content !== existing) {
      writeFileSync(full, content);
      refreshed.push(path);
    }
  }
  return refreshed;
}
