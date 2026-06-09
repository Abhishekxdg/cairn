#!/usr/bin/env node
// Runs automatically after `npm install`.
//
// Automatic setup (opt-out, not opt-in):
//   - Global installs wire the agent bootstrap (~/.claude/CLAUDE.md etc.).
//   - Local installs set up the target repo (journal + rules + git hook + index).
//   - Skips our own dev install and CI (auto-committing in CI would be harmful).
//   - Opt out with CAIRN_NO_AUTO_SETUP=1 (or CAIRN_NO_POSTINSTALL=1 to skip entirely).
//   - Never fails the install: any error is swallowed with a hint.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const optedOut =
  process.env.CAIRN_NO_POSTINSTALL === "1" || process.env.CAIRN_NO_AUTO_SETUP === "1";

async function main() {
  if (process.env.CAIRN_NO_POSTINSTALL === "1") return;

  const projectDir = process.env.INIT_CWD || process.cwd();
  const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

  // --- Global install: wire the agent bootstrap automatically ---------------
  if (process.env.npm_config_global === "true") {
    if (optedOut) {
      process.stdout.write(
        "\n[cairn] Installed globally. Auto-setup skipped (CAIRN_NO_AUTO_SETUP).\n" +
          "  Wire it yourself with `cairn install-global`.\n\n",
      );
      return;
    }
    try {
      const { installGlobal } = await import("../dist/setup/global.js");
      const { renderGlobalSetup } = await import("../dist/cli/screens.js");
      process.stdout.write("\n" + renderGlobalSetup(installGlobal()) + "\n");
      process.stdout.write(
        "  (automatic — undo with `cairn uninstall-global`, or set CAIRN_NO_AUTO_SETUP=1)\n\n",
      );
    } catch (err) {
      process.stdout.write(
        "\n[cairn] Installed globally. Finish wiring with `cairn install-global`.\n" +
          `  (${err && err.message ? err.message : err})\n\n`,
      );
    }
    return;
  }

  // --- Local install: set up the target repo automatically ------------------
  // Don't touch our own repo during development.
  if (resolve(projectDir) === pkgDir) return;
  // Skip CI: the git post-commit hook auto-commits the journal, which is the
  // wrong thing to do in an automated pipeline. Opt in explicitly with CAIRN_SETUP=1.
  if (process.env.CI && process.env.CAIRN_SETUP !== "1") {
    process.stdout.write(
      "\n[cairn] Installed. Auto-setup skipped in CI — run `cairn setup` to enable.\n\n",
    );
    return;
  }
  if (optedOut) {
    process.stdout.write(
      "\n[cairn] Installed. Auto-setup skipped (CAIRN_NO_AUTO_SETUP).\n" +
        "  Set it up with `cairn setup`.\n\n",
    );
    return;
  }

  try {
    const { setupProject, classifyRepo } = await import("../dist/setup/install.js");
    const { renderProjectSetup } = await import("../dist/cli/screens.js");

    const kind = classifyRepo(projectDir);
    // Existing repos get the code graph immediately so `cairn relevant` works
    // from the first query; fresh repos skip the (empty) index for speed.
    const res = setupProject(projectDir, { buildIndex: kind === "existing" });
    process.stdout.write("\n" + renderProjectSetup(res) + "\n");
    process.stdout.write("  (automatic — set CAIRN_NO_AUTO_SETUP=1 to disable)\n\n");
  } catch (err) {
    // Never break `npm install`.
    process.stdout.write(
      "\n[cairn] Setup skipped (run `cairn setup` to finish): " +
        `${err && err.message ? err.message : err}\n\n`,
    );
  }
}

main();
