#!/usr/bin/env node
// Runs automatically after `npm install cairn` inside a project.
//
// It wires Cairn into the project with ZERO extra steps: creates the `.agent/`
// journal and injects the Cairn usage rules into the coding agents' instruction
// files (AGENTS.md, CLAUDE.md, and any existing GEMINI.md/.cursorrules/Copilot
// files). After this, every agent that opens the repo is taught to use the
// journal — no MCP, no manual config.
//
// Safe + unobtrusive:
//   - Skips global installs (no project to target) and prints a hint instead.
//   - Skips our own dev install and CI unless CAIRN_SETUP=1.
//   - Never fails the install: any error is swallowed with a hint.
//   - Honors CAIRN_NO_POSTINSTALL=1 to opt out.

import { fileURLToPath } from "node:url";
import { dirname, resolve, delimiter, join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const PATH_BEGIN = "# >>> cairn PATH >>>";
const PATH_END = "# <<< cairn PATH <<<";

/**
 * When a global install lands the `cairn` bin in a directory that is NOT on the
 * user's PATH, typing `cairn` fails with a cryptic "command not found". Fix it
 * automatically: append a small, clearly-marked block to the user's shell rc so
 * `cairn` is on PATH in every new shell. Idempotent (re-runs don't duplicate)
 * and opt-out via CAIRN_NO_PATH=1. Returns a status string to print, or "".
 */
function ensurePath() {
  if (process.env.CAIRN_NO_PATH === "1") return "";
  // The global bin dir is where node itself lives (…/<prefix>/bin/node).
  const binDir = dirname(process.execPath);
  const onPath = (process.env.PATH || "")
    .split(delimiter)
    .some((p) => p && resolve(p) === resolve(binDir));
  if (onPath) return "";

  // Pick the rc file for the user's shell.
  const shell = process.env.SHELL || "";
  const rcName = shell.includes("zsh")
    ? ".zshrc"
    : shell.includes("bash")
      ? ".bashrc"
      : ".profile";
  const home = homedir();
  if (!home) return "";
  const rc = join(home, rcName);

  try {
    const existing = existsSync(rc) ? readFileSync(rc, "utf8") : "";
    // Already wired by us (or the dir is already exported)? Don't touch it.
    if (existing.includes(PATH_BEGIN) || existing.includes(`"${binDir}:$PATH"`)) {
      return "";
    }
    const block =
      `${PATH_BEGIN}\n` +
      `export PATH="${binDir}:$PATH"\n` +
      `${PATH_END}\n`;
    const next = existing.trimEnd();
    writeFileSync(rc, (next ? next + "\n\n" : "") + block);
    return (
      `\n[cairn] Added ${binDir} to your PATH in ${rc.replace(home, "~")}.\n` +
      `  Open a new terminal, or run:  source ${rc.replace(home, "~")}\n` +
      `  (opt out next time with CAIRN_NO_PATH=1; remove the marked block to undo.)\n`
    );
  } catch (err) {
    // Never break the install — fall back to telling the user how.
    return (
      `\n[cairn] NOTE: ${binDir} is not on your PATH. Add it:\n` +
      `    echo 'export PATH="${binDir}:$PATH"' >> ~/${rcName}\n` +
      `    source ~/${rcName}\n` +
      `  (${err && err.message ? err.message : err})\n`
    );
  }
}

async function main() {
  if (process.env.CAIRN_NO_POSTINSTALL === "1") return;

  // Where the user ran `npm install` — the project root.
  const projectDir = process.env.INIT_CWD || process.cwd();
  const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

  // Global install: do NOT silently mutate the user's home (~/.claude/CLAUDE.md,
  // ~/.config/cairn/AGENTS.md, …). A postinstall script writing outside its own
  // package is exactly what supply-chain tooling flags, so global bootstrap is
  // opt-in: print how to enable it. CAIRN_SETUP=1 allows unattended wiring.
  if (process.env.npm_config_global === "true") {
    if (process.env.CAIRN_SETUP === "1") {
      try {
        const { installGlobal } = await import("../dist/setup/global.js");
        const { renderGlobalSetup } = await import("../dist/cli/screens.js");
        process.stdout.write("\n" + renderGlobalSetup(installGlobal()) + "\n");
      } catch (err) {
        process.stdout.write(
          "\n[cairn] Installed globally. Finish wiring with `cairn install-global`.\n" +
            `  (${err && err.message ? err.message : err})\n\n`,
        );
      }
    } else {
      process.stdout.write(
        "\n[cairn] Installed globally.\n" +
          "  Run `cairn install-global` to let agents auto-set-up your repos\n" +
          "  (writes a small bootstrap rule into ~/.claude/CLAUDE.md etc.; undo with\n" +
          "  `cairn uninstall-global`).\n",
      );
    }
    const pathStatus = ensurePath();
    if (pathStatus) process.stdout.write(pathStatus);
    process.stdout.write("\n");
    return;
  }

  // Don't touch our own repo during development, and skip CI unless asked.
  if (resolve(projectDir) === pkgDir) return;
  if (process.env.CI && process.env.CAIRN_SETUP !== "1") return;

  try {
    const { setupProject, classifyRepo } = await import("../dist/setup/install.js");
    const { renderProjectSetup } = await import("../dist/cli/screens.js");

    const kind = classifyRepo(projectDir);

    // An EXISTING repo (real commit history) is not ours to wire silently. Ask
    // the user right here whether to add Cairn; on yes, build the code graph so
    // `cairn relevant` works on their codebase immediately. When we can't ask
    // (no TTY: CI, piped install, `npm ci`), fall back to the agent-driven hint
    // so the install never blocks.
    if (kind === "existing") {
      // CAIRN_SETUP=1 is an explicit "yes, just do it" for automation.
      const consented =
        process.env.CAIRN_SETUP === "1" ? true : await askYesNo(projectDir);
      if (consented === true) {
        process.stdout.write(
          "\n" + renderProjectSetup(setupProject(projectDir, { buildIndex: true })) + "\n",
        );
      } else if (consented === false) {
        process.stdout.write(
          "\n[cairn] Skipped. Run `cairn setup` anytime to add Cairn to this repo.\n\n",
        );
      } else {
        // No TTY — defer to the agent-driven flow.
        process.stdout.write(
          "\n[cairn] Detected an existing repo. Your AI agent will offer to set up\n" +
            "  shared memory + a code graph on its next action — or run `cairn setup`.\n\n",
        );
      }
      return;
    }

    // New/empty dir or already initialized: nothing established to disturb. With
    // CAIRN_SETUP=1, wire it now; otherwise leave the agent-driven hint.
    if (process.env.CAIRN_SETUP === "1") {
      process.stdout.write("\n" + renderProjectSetup(setupProject(projectDir)) + "\n");
      return;
    }
    process.stdout.write(
      "\n[cairn] Installed. Your AI agent will offer to set up shared memory\n" +
        "  (a `.agent/` journal) on its next action — or run `cairn setup` yourself.\n\n",
    );
  } catch (err) {
    // Never break `npm install`.
    process.stdout.write(
      "\n[cairn] Setup skipped (run `cairn setup` to finish): " +
        `${err && err.message ? err.message : err}\n\n`,
    );
  }
}

/**
 * Ask a yes/no question on the terminal, defaulting to YES.
 * Returns true/false on an answer, or null when there's no interactive TTY
 * (CI, piped install, `npm ci`) — the caller must NOT block the install there.
 */
async function askYesNo(projectDir) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise((res) =>
      rl.question(
        `\n[cairn] Add shared agent memory + a code graph to this repo?\n  ${projectDir}\n  [Y/n] `,
        res,
      ),
    );
    const a = String(answer).trim().toLowerCase();
    return a === "" || a === "y" || a === "yes";
  } finally {
    rl.close();
  }
}

main();
