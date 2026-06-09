import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import {
  GLOBAL_BEGIN_MARKER,
  GLOBAL_END_MARKER,
  globalRulesBlock,
  upsertBetween,
  GLOBAL_RULES_VERSION,
  parseRulesVersion,
} from "./rules.js";

/**
 * Global bootstrap (Option A): install Cairn once, globally, and have agents
 * self-set-up every project.
 *
 * This writes a short bootstrap rule into the developer's GLOBAL agent
 * instruction files (the ones an agent reads on every machine, not per-repo).
 * That rule tells the agent: "if a repo has no `.agent/`, run `cairn setup`." So
 * the human never runs per-project setup again — the agent does it.
 */

/**
 * Known global agent instruction files, relative to the home directory.
 * `primary` files are created even if absent; others are only updated if the
 * tool's config dir already exists (so we don't fabricate config for tools the
 * developer doesn't use).
 */
export const GLOBAL_AGENT_FILES: Array<{
  /** Path relative to home. */
  rel: string;
  /** Directory (relative to home) that must exist for non-primary targets. */
  dir: string;
  agent: string;
  primary: boolean;
}> = [
  { rel: ".claude/CLAUDE.md", dir: ".claude", agent: "Claude Code", primary: true },
  { rel: ".codex/AGENTS.md", dir: ".codex", agent: "Codex", primary: false },
  { rel: ".gemini/GEMINI.md", dir: ".gemini", agent: "Gemini CLI", primary: false },
  { rel: ".config/cairn/AGENTS.md", dir: ".config/cairn", agent: "generic", primary: true },
];

export interface GlobalSetupResult {
  home: string;
  filesCreated: string[];
  filesUpdated: string[];
}

/**
 * Install the global bootstrap rule.
 *
 * @param opts.home  Home directory (defaults to os.homedir()); injectable for tests.
 * @param opts.all   Create every known global file, even for tools whose config
 *   dir is absent.
 */
export function installGlobal(
  opts: { home?: string; all?: boolean } = {},
): GlobalSetupResult {
  const home = opts.home ?? homedir();
  const filesCreated: string[] = [];
  const filesUpdated: string[] = [];

  for (const { rel, dir, primary } of GLOBAL_AGENT_FILES) {
    const full = join(home, rel);
    const exists = existsSync(full);
    const dirExists = existsSync(join(home, dir));
    if (!exists && !primary && !dirExists && !opts.all) continue;

    const existing = exists ? readFileSync(full, "utf8") : "";
    const { content, updated } = upsertBetween(
      existing,
      GLOBAL_BEGIN_MARKER,
      GLOBAL_END_MARKER,
      globalRulesBlock(),
    );
    if (exists && updated && content === existing) continue; // no change

    if (!exists) mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    (exists ? filesUpdated : filesCreated).push(rel);
  }

  return { home, filesCreated, filesUpdated };
}

/** Remove the global bootstrap block from all global agent files. */
export function uninstallGlobal(opts: { home?: string } = {}): GlobalSetupResult {
  const home = opts.home ?? homedir();
  const filesUpdated: string[] = [];
  for (const { rel } of GLOBAL_AGENT_FILES) {
    const full = join(home, rel);
    if (!existsSync(full)) continue;
    const existing = readFileSync(full, "utf8");
    const start = existing.indexOf(GLOBAL_BEGIN_MARKER);
    if (start === -1) continue;
    const stop = existing.indexOf(GLOBAL_END_MARKER, start);
    if (stop === -1) continue;
    const next = (existing.slice(0, start) + existing.slice(stop + GLOBAL_END_MARKER.length))
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd();
    writeFileSync(full, next ? next + "\n" : "");
    filesUpdated.push(rel);
  }
  return { home, filesCreated: [], filesUpdated };
}

/**
 * Self-healing global rules: rewrite any global agent file whose bootstrap block
 * is older than `GLOBAL_RULES_VERSION` (or unstamped). Only touches files that
 * already contain a block — never creates new ones. Returns the rels refreshed.
 */
export function refreshGlobalRules(opts: { home?: string } = {}): string[] {
  const home = opts.home ?? homedir();
  const refreshed: string[] = [];
  for (const { rel } of GLOBAL_AGENT_FILES) {
    const full = join(home, rel);
    if (!existsSync(full)) continue;
    const existing = readFileSync(full, "utf8");
    if (!existing.includes(GLOBAL_BEGIN_MARKER)) continue;
    if (parseRulesVersion(existing) >= GLOBAL_RULES_VERSION) continue;
    const { content } = upsertBetween(
      existing,
      GLOBAL_BEGIN_MARKER,
      GLOBAL_END_MARKER,
      globalRulesBlock(),
    );
    if (content !== existing) {
      writeFileSync(full, content);
      refreshed.push(rel);
    }
  }
  return refreshed;
}
