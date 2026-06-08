import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isInitialized, findRoot, agentPaths } from "../core/paths.js";
import { init } from "../core/manifest.js";
import { EventStore } from "../core/store.js";
import { detectGit } from "../engines/git.js";
import { syncGit } from "../engines/gitsync.js";
import { writeContextFile } from "../engines/recall.js";
import { BEGIN_MARKER, END_MARKER, rulesBlock, upsertBetween } from "./rules.js";

/** Absolute path to this package's `ajp` CLI entry (dist/setup → ../../bin). */
const AJP_BIN = resolve(dirname(fileURLToPath(import.meta.url)), "../../bin/ajp.js");

/**
 * A robust `ajp` invocation that works even when `ajp` isn't on PATH: prefer the
 * PATH command, fall back to running this package's binary with node.
 */
export function ajpInvocation(): string {
  return `node ${AJP_BIN}`;
}

const HOOK_BEGIN = "# AJP:BEGIN auto-capture";
const HOOK_END = "# AJP:END";
const HOOK_BODY = `${HOOK_BEGIN}
if command -v ajp >/dev/null 2>&1; then ajp sync >/dev/null 2>&1 || true
elif [ -f "${AJP_BIN}" ]; then node "${AJP_BIN}" sync >/dev/null 2>&1 || true
fi
${HOOK_END}`;

/**
 * Install a git `post-commit` hook that runs `ajp sync`, so every commit is
 * auto-captured into the journal with zero agent effort. Idempotent; preserves
 * any existing hook content. Returns true if a repo hook was written.
 */
export function installGitHook(root: string): boolean {
  const info = detectGit(root);
  if (!info.isRepo || !info.gitDir) return false;
  const hooksDir = join(info.gitDir, "hooks");
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
 * Project setup — the one-shot that makes AJP "just work" for every coding agent
 * without MCP.
 *
 * It (1) creates the `.agent/` journal if missing, and (2) injects the AJP usage
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
}

/**
 * Insert or update the AJP block in a single file's content. Returns the new
 * content and whether the file already had a block.
 */
export function upsertBlock(
  existing: string,
  ajpBin = "ajp",
): { content: string; updated: boolean } {
  return upsertBetween(existing, BEGIN_MARKER, END_MARKER, rulesBlock(ajpBin));
}

/**
 * Set up AJP in a project: create the journal and inject agent rules.
 *
 * @param root  Project root.
 * @param opts.all  Create every known agent file, not just the primary ones.
 * @param opts.gitHook  Set false to skip installing the git auto-capture hook.
 */
export function setupProject(
  root: string,
  opts: { all?: boolean; gitHook?: boolean } = {},
): SetupResult {
  const filesCreated: string[] = [];
  const filesUpdated: string[] = [];
  // Embed a PATH-independent invocation in the rules so agents always reach ajp.
  const ajpBin = ajpInvocation();

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
    const { content, updated } = upsertBlock(existing, ajpBin);
    if (exists && updated && content === existing) continue; // nothing changed

    if (!exists) mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    if (exists) filesUpdated.push(path);
    else filesCreated.push(path);
  }

  // 3. Wire git auto-capture: install the post-commit hook + set the sync
  //    baseline so future commits flow into the journal with no agent effort.
  let gitHook = false;
  {
    const store = new EventStore(agentPaths(root).db);
    try {
      if (opts.gitHook !== false) {
        gitHook = installGitHook(root);
        if (gitHook) syncGit(store, root); // baseline or capture
      }
      // 4. Render the instant-recall file so a new agent is oriented by one read.
      writeContextFile(store, root);
    } finally {
      store.close();
    }
  }

  return {
    root: findRoot(root) ?? root,
    initializedJournal,
    filesCreated,
    filesUpdated,
    gitHook,
  };
}
