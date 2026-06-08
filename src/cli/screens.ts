import { banner, box, step, style } from "./ui.js";
import { AGENT_FILES, type SetupResult } from "../setup/install.js";
import { GLOBAL_AGENT_FILES, type GlobalSetupResult } from "../setup/global.js";

/**
 * Graphical "screens" for the install / setup flows. Shared by the `cairn` CLI and
 * the npm postinstall step so the experience is identical however Cairn is set up.
 */

/** Short, pretty agent names keyed by the instruction file they own. */
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

/** Pad the action label so the trailing file note aligns in the checklist. */
function row(label: string, file: string): string {
  return step(label.padEnd(26), file);
}

/** The graphical result of a per-project setup. */
export function renderProjectSetup(r: SetupResult): string {
  const lines: string[] = [];
  lines.push(
    r.initializedJournal
      ? step("created shared memory".padEnd(26), ".agent/ journal")
      : step("shared memory ready".padEnd(26), ".agent/ journal"),
  );
  for (const f of [...r.filesCreated, ...r.filesUpdated]) {
    lines.push(row(`taught ${agentFor(f)}`, f));
  }
  if (r.filesCreated.length + r.filesUpdated.length === 0) {
    lines.push(style.dim("agents already up to date"));
  }
  if (r.gitHook) {
    lines.push(step("git auto-capture".padEnd(26), "post-commit hook"));
  }

  const next = box(
    "What happens now",
    [
      "Your AI agents read & write a shared memory journal",
      "as they work — no MCP, no manual steps.",
      "",
      `${style.cyan("cairn status")}     ${style.dim("see the current state")}`,
      `${style.cyan("cairn timeline")}   ${style.dim("what happened, by day")}`,
      `${style.cyan("cairn context")}    ${style.dim("compact context for a prompt")}`,
    ],
    { color: style.gray },
  );

  return [
    banner(),
    box("Project ready", lines),
    "",
    next,
    "",
  ].join("\n");
}

/** The graphical result of the global bootstrap install. */
export function renderGlobalSetup(r: GlobalSetupResult): string {
  const lines: string[] = [];
  const touched = [...r.filesCreated, ...r.filesUpdated];
  if (touched.length) {
    for (const f of touched) lines.push(row(`taught ${agentFor(f)}`, `~/${f}`));
  } else {
    lines.push(style.dim("global agent rules already current"));
  }

  const next = box(
    "What happens now",
    [
      `Installed ${style.bold("once")} — you never set up a project again.`,
      "",
      "When an agent opens any repo without a journal, it will",
      `run ${style.cyan("cairn setup")} itself and start recording.`,
      "",
      `${style.dim("undo:")} cairn uninstall-global`,
    ],
    { color: style.gray },
  );

  return [
    banner(),
    box("Installed globally", lines),
    "",
    next,
    "",
  ].join("\n");
}

