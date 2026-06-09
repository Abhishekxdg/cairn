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
import { dirname, resolve } from "node:path";

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
          "  `cairn uninstall-global`).\n\n",
      );
    }
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
