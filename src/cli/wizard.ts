/**
 * Interactive setup wizard — the "GUI installer" for terminals.
 *
 * Zero dependencies: a tiny arrow-key prompt built on node:readline raw mode.
 * Falls back to recommended defaults when there's no TTY (pipes, CI, agents), so
 * the same entry point is safe to call unattended. Drives the existing
 * `setupProject` / `installGlobal` engines — it only adds the human-friendly
 * front door, never new setup logic.
 */
import * as readline from "node:readline";
import { setupProject, classifyRepo, type RepoKind } from "../setup/install.js";
import { installGlobal, GLOBAL_AGENT_FILES } from "../setup/global.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { renderProjectSetup, renderGlobalSetup } from "./screens.js";

const useColor = process.stdout.isTTY && process.env["NO_COLOR"] === undefined;
const w = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = {
  bold: w("1"), dim: w("2"), green: w("32"), cyan: w("36"), gray: w("90"), yellow: w("33"),
};
const write = (s: string) => process.stdout.write(s);
const line = (s = "") => process.stdout.write(s + "\n");

const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);

/** Single-choice arrow-key menu. Returns the chosen index (default when no TTY). */
function select(message: string, choices: string[], def = 0): Promise<number> {
  if (!isTTY) return Promise.resolve(def);
  let idx = def;
  const n = choices.length;
  const render = (first: boolean) => {
    if (!first) write(`\x1b[${n}A`); // move cursor up to overwrite the menu
    for (let i = 0; i < n; i++) {
      const sel = i === idx;
      write("\x1b[2K"); // clear line
      line(sel ? `${c.cyan("❯")} ${c.bold(choices[i]!)}` : `  ${c.dim(choices[i]!)}`);
    }
  };
  line(c.bold(message));
  render(true);
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode!(true);
  process.stdin.resume();
  return new Promise((resolve) => {
    const onKey = (_s: string, k: readline.Key) => {
      if (k.name === "up" || (k.ctrl && k.name === "p")) { idx = (idx - 1 + n) % n; render(false); }
      else if (k.name === "down" || (k.ctrl && k.name === "n")) { idx = (idx + 1) % n; render(false); }
      else if (k.name === "return") { cleanup(); resolve(idx); }
      else if (k.name === "escape" || (k.ctrl && k.name === "c")) { cleanup(); process.exit(130); }
    };
    const cleanup = () => {
      process.stdin.removeListener("keypress", onKey);
      process.stdin.setRawMode!(false);
      process.stdin.pause();
    };
    process.stdin.on("keypress", onKey);
  });
}

/** Yes/No prompt. Returns boolean (default when no TTY). */
async function confirm(message: string, def = true): Promise<boolean> {
  const i = await select(message, def ? ["Yes", "No"] : ["No", "Yes"], 0);
  return def ? i === 0 : i === 1;
}

/** Which coding agents already have a home dir under ~/ (so we wire those). */
function detectedAgents(home: string): string[] {
  return GLOBAL_AGENT_FILES
    .filter((f) => f.agent !== "generic" && existsSync(join(home, f.dir)))
    .map((f) => f.agent);
}

/** Run the interactive quickstart: global bootstrap + this-repo setup. */
export async function runQuickstart(cwd: string): Promise<void> {
  const home = homedir();
  line();
  line(c.cyan(c.bold("  ⛰  Cairn quickstart")));
  line(c.dim("  Shared, git-like memory for your AI agents.\n"));

  const kind: RepoKind = classifyRepo(cwd);
  const projectName = (() => {
    try { return JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).name ?? cwd; }
    catch { return cwd.split("/").pop() || cwd; }
  })();
  const agents = detectedAgents(home);
  line(`  Repo: ${c.bold(String(projectName))} ${c.dim(`(${kind})`)}`);
  line(`  Agents found: ${agents.length ? c.bold(agents.join(", ")) : c.dim("none detected")}\n`);

  const mode = await select(
    "How would you like to set up Cairn?",
    [
      "Recommended — global bootstrap + this repo + git hook + code graph",
      "Customize each step",
      "Cancel",
    ],
    0,
  );
  if (mode === 2) { line(c.dim("\nCancelled. Nothing changed.")); return; }

  let doGlobal = true, all = false, gitHook = true, buildIndex = true;
  if (mode === 1) {
    doGlobal = await confirm("Wire the global agent bootstrap (~/.claude, ~/.codex …)?", true);
    all = await confirm("Wire every supported agent file in this repo (not just the primary ones)?", false);
    gitHook = await confirm("Install the git post-commit hook (auto-captures commits)?", true);
    buildIndex = await confirm("Build the static code graph now (powers `cairn relevant`)?", true);
  }

  line();
  if (doGlobal) {
    const g = installGlobal({ all });
    line(renderGlobalSetup(g));
    line();
  }
  const r = setupProject(cwd, { all, gitHook, buildIndex });
  line(renderProjectSetup(r));

  line();
  line(c.green("  ✔ Ready.") + c.dim("  Start any session with ") + c.bold("cairn recall") + c.dim("."));
  line(c.dim("  Pin a durable fact: ") + c.bold('cairn anchor "never write to prod"'));
  line();
}
