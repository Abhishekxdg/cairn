#!/usr/bin/env node
// Runs automatically after `npm install`.
//
// Safe + unobtrusive:
//   - Global installs print a hint instead of mutating shell config or agent files.
//   - Local installs print a hint instead of mutating the target repo.
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
  // shell rc files, ~/.config/cairn/AGENTS.md, …). A postinstall script writing
  // outside its own package is exactly what supply-chain tooling flags, so global
  // bootstrap is opt-in: print how to enable it. CAIRN_SETUP=1 allows unattended
  // wiring for users who explicitly request it.
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
    process.stdout.write("\n");
    return;
  }

  // Don't touch our own repo during development, and skip CI unless asked.
  if (resolve(projectDir) === pkgDir) return;
  if (process.env.CI && process.env.CAIRN_SETUP !== "1") return;

  if (process.env.CAIRN_SETUP !== "1") {
    process.stdout.write(
      "\n[cairn] Installed. Run `cairn setup` to add shared agent memory\n" +
        "  to this repo, or set CAIRN_SETUP=1 for explicit automated setup.\n\n",
    );
    return;
  }

  try {
    const { setupProject, classifyRepo } = await import("../dist/setup/install.js");
    const { renderProjectSetup } = await import("../dist/cli/screens.js");

    const kind = classifyRepo(projectDir);

    // CAIRN_SETUP=1 is explicit consent for automation. Existing repos get the
    // code graph immediately so `cairn relevant` works from the first query.
    if (kind === "existing") {
      process.stdout.write(
        "\n" + renderProjectSetup(setupProject(projectDir, { buildIndex: true })) + "\n",
      );
      return;
    }

    process.stdout.write("\n" + renderProjectSetup(setupProject(projectDir)) + "\n");
  } catch (err) {
    // Never break `npm install`.
    process.stdout.write(
      "\n[cairn] Setup skipped (run `cairn setup` to finish): " +
        `${err && err.message ? err.message : err}\n\n`,
    );
  }
}

main();
