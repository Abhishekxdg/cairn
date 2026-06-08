import { AGENT_FILES, type SetupResult } from "../setup/install.js";
import { GLOBAL_AGENT_FILES, type GlobalSetupResult } from "../setup/global.js";

/**
 * Plain-text summaries for the install / setup flows. Shared by the `cairn` CLI
 * and the npm postinstall step. Deliberately non-graphical — no banner, no boxes
 * — so setup is quiet whether a human or an agent runs it.
 */

/** Short agent names keyed by the instruction file they own. */
const AGENT_NAMES: Record<string, string> = {
  "AGENTS.md": "Codex · OpenHands",
  "CLAUDE.md": "Claude Code",
  "GEMINI.md": "Gemini",
  ".cursorrules": "Cursor",
  ".github/copilot-instructions.md": "Copilot",
  ".claude/CLAUDE.md": "Claude Code",
  ".codex/AGENTS.md": "Codex",
  ".gemini/GEMINI.md": "Gemini",
  ".config/cairn/AGENTS.md": "all agents",
};

function agentFor(path: string): string {
  const key = path.replace(/^~\//, "");
  return (
    AGENT_NAMES[key] ??
    AGENT_FILES.find((f) => f.path === key)?.agent ??
    GLOBAL_AGENT_FILES.find((f) => f.rel === key)?.agent ??
    "agent"
  );
}

/** Plain summary of a per-project setup. */
export function renderProjectSetup(r: SetupResult): string {
  const lines: string[] = ["Cairn — project ready"];
  lines.push(
    r.initializedJournal
      ? "  ✓ created shared memory   .agent/ journal"
      : "  ✓ shared memory ready     .agent/ journal",
  );
  for (const f of [...r.filesCreated, ...r.filesUpdated]) {
    lines.push(`  ✓ taught ${agentFor(f)}: ${f}`);
  }
  if (r.filesCreated.length + r.filesUpdated.length === 0) {
    lines.push("  · agents already up to date");
  }
  if (r.gitHook) {
    lines.push("  ✓ git auto-capture        post-commit hook");
  }
  lines.push("");
  lines.push("Next: cairn status · cairn timeline · cairn context");
  return lines.join("\n");
}

/** Plain summary of the global bootstrap install. */
export function renderGlobalSetup(r: GlobalSetupResult): string {
  const lines: string[] = ["Cairn — installed globally"];
  const touched = [...r.filesCreated, ...r.filesUpdated];
  if (touched.length) {
    for (const f of touched) lines.push(`  ✓ taught ${agentFor(f)}: ~/${f}`);
  } else {
    lines.push("  · global agent rules already current");
  }
  lines.push("");
  lines.push(
    "Agents will ask before setting up a repo that has no .agent/ journal.",
  );
  lines.push("Undo: cairn uninstall-global");
  return lines.join("\n");
}
