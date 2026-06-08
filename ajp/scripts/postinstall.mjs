#!/usr/bin/env node
// Runs automatically after `npm install agent-journal-protocol` inside a project.
//
// It wires AJP into the project with ZERO extra steps: creates the `.agent/`
// journal and injects the AJP usage rules into the coding agents' instruction
// files (AGENTS.md, CLAUDE.md, and any existing GEMINI.md/.cursorrules/Copilot
// files). After this, every agent that opens the repo is taught to use the
// journal — no MCP, no manual config.
//
// Safe + unobtrusive:
//   - Skips global installs (no project to target) and prints a hint instead.
//   - Skips our own dev install and CI unless AJP_SETUP=1.
//   - Never fails the install: any error is swallowed with a hint.
//   - Honors AJP_NO_POSTINSTALL=1 to opt out.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

async function main() {
  if (process.env.AJP_NO_POSTINSTALL === "1") return;

  // Where the user ran `npm install` — the project root.
  const projectDir = process.env.INIT_CWD || process.cwd();
  const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

  // Global install: wire the GLOBAL bootstrap so agents self-set-up every repo.
  if (process.env.npm_config_global === "true") {
    try {
      const { installGlobal } = await import("../dist/setup/global.js");
      const { renderGlobalSetup } = await import("../dist/cli/screens.js");
      process.stdout.write("\n" + renderGlobalSetup(installGlobal()) + "\n");
    } catch (err) {
      process.stdout.write(
        "\n[agent-journal-protocol] Installed globally. Finish wiring with `ajp install-global`.\n" +
          `  (${err && err.message ? err.message : err})\n\n`,
      );
    }
    return;
  }

  // Don't set up our own repo during development, and skip CI unless asked.
  if (resolve(projectDir) === pkgDir) return;
  if (process.env.CI && process.env.AJP_SETUP !== "1") return;

  try {
    const { setupProject } = await import("../dist/setup/install.js");
    const { renderProjectSetup } = await import("../dist/cli/screens.js");
    process.stdout.write("\n" + renderProjectSetup(setupProject(projectDir)) + "\n");
  } catch (err) {
    // Never break `npm install`.
    process.stdout.write(
      "\n[agent-journal-protocol] Setup skipped (run `ajp setup` to finish): " +
        `${err && err.message ? err.message : err}\n\n`,
    );
  }
}

main();
