import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { isInitialized, findRoot } from "../core/paths.js";
import { init } from "../core/manifest.js";
import { BEGIN_MARKER, END_MARKER, rulesBlock } from "./rules.js";

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
}

/**
 * Insert or update the AJP block in a single file's content. Returns the new
 * content and whether the file already had a block.
 */
export function upsertBlock(existing: string): { content: string; updated: boolean } {
  const block = rulesBlock().trimEnd();
  const start = existing.indexOf(BEGIN_MARKER);
  if (start !== -1) {
    const end = existing.indexOf(END_MARKER, start);
    if (end !== -1) {
      const before = existing.slice(0, start);
      const after = existing.slice(end + END_MARKER.length);
      return { content: (before + block + after).replace(/\n{3,}/g, "\n\n"), updated: true };
    }
  }
  // No existing block — append to the end, separated by a blank line.
  const base = existing.trimEnd();
  const content = base ? `${base}\n\n${block}\n` : `${block}\n`;
  return { content, updated: false };
}

/**
 * Set up AJP in a project: create the journal and inject agent rules.
 *
 * @param root  Project root.
 * @param opts.all  Create every known agent file, not just the primary ones.
 */
export function setupProject(
  root: string,
  opts: { all?: boolean } = {},
): SetupResult {
  const filesCreated: string[] = [];
  const filesUpdated: string[] = [];

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
    const { content, updated } = upsertBlock(existing);
    if (exists && updated && content === existing) continue; // nothing changed

    if (!exists) mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    if (exists) filesUpdated.push(path);
    else filesCreated.push(path);
  }

  return {
    root: findRoot(root) ?? root,
    initializedJournal,
    filesCreated,
    filesUpdated,
  };
}
