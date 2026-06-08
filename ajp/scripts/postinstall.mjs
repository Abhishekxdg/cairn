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

  // Global install: npm sets npm_config_global=true; there's no project to set up.
  if (process.env.npm_config_global === "true") {
    process.stdout.write(
      "\n[agent-journal-protocol] Installed globally. In a project run:\n" +
        "  ajp setup        # create .agent/ + teach your coding agents\n\n",
    );
    return;
  }

  // Don't set up our own repo during development, and skip CI unless asked.
  if (resolve(projectDir) === pkgDir) return;
  if (process.env.CI && process.env.AJP_SETUP !== "1") return;

  try {
    const { setupProject } = await import("../dist/setup/install.js");
    const r = setupProject(projectDir);
    const touched = [...r.filesCreated, ...r.filesUpdated];
    process.stdout.write(
      "\n[agent-journal-protocol] ✔ Set up shared agent memory.\n" +
        (r.initializedJournal ? "  • created .agent/ journal\n" : "  • .agent/ journal present\n") +
        (touched.length ? `  • taught agents via: ${touched.join(", ")}\n` : "") +
        "  Your coding agents will now read/write the journal with the `ajp` CLI.\n" +
        "  Re-run anytime: `ajp setup`  ·  opt out: AJP_NO_POSTINSTALL=1\n\n",
    );
  } catch (err) {
    // Never break `npm install`.
    process.stdout.write(
      "\n[agent-journal-protocol] Setup skipped (run `ajp setup` to finish): " +
        `${err && err.message ? err.message : err}\n\n`,
    );
  }
}

main();
