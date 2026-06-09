/**
 * Interactive setup wizard — the "GUI installer" for terminals.
 *
 * Zero dependencies: a small but polished arrow-key UI built on node:readline raw
 * mode + ANSI (boxes, a context panel, a checkbox multiselect, an animated step
 * checklist, and a summary card). Falls back to recommended defaults when there's
 * no TTY (pipes, CI, agents), so the same entry point is safe unattended. Drives
 * the existing setup engines — it only adds the human-friendly front door.
 */
import * as readline from "node:readline";
import { execFileSync } from "node:child_process";
import { setupProject, classifyRepo, type RepoKind, type SetupResult } from "../setup/install.js";
import { installGlobal, GLOBAL_AGENT_FILES } from "../setup/global.js";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

// --- theme ------------------------------------------------------------------
const useColor = process.stdout.isTTY && process.env["NO_COLOR"] === undefined;
const w = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const t = {
  bold: w("1"), dim: w("2"), italic: w("3"),
  green: w("32"), cyan: w("36"), gray: w("90"), yellow: w("33"),
  magenta: w("35"), blue: w("34"), red: w("31"),
  cyanBg: w("46;30"),
};
const SYM = { ok: "✓", no: "✗", dot: "·", arrow: "❯", box: "◆", on: "◉", off: "◯", run: "▸" };

const write = (s: string) => process.stdout.write(s);
const line = (s = "") => process.stdout.write(s + "\n");
const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const VERSION = (() => {
  try {
    const p = join(dirname(fileURLToPath(import.meta.url)), "../../package.json");
    return "v" + (JSON.parse(readFileSync(p, "utf8")).version as string);
  } catch { return ""; }
})();

// Visible display width: strip ANSI, then count known wide glyphs as 2 cells so
// box borders align (JS .length reports the mountain/emoji as 1).
const vlen = (s: string) => {
  const bare = s.replace(/\x1b\[[0-9;]*m/g, "");
  const wide = (bare.match(/⛰/gu) || []).length; // the mountain renders 2-wide in most terminals
  return bare.length + wide;
};
const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - vlen(s)));

/** Draw a rounded box around content lines, with an optional title. */
function box(lines: string[], opts: { title?: string; width?: number; color?: (s: string) => string } = {}): string[] {
  const color = opts.color ?? t.gray;
  const inner = Math.min(opts.width ?? 60, (process.stdout.columns || 80) - 2);
  const contentW = inner - 2;
  const top = opts.title
    ? color("╭─ ") + t.bold(opts.title) + color(" " + "─".repeat(Math.max(0, inner - vlen(opts.title) - 3)) + "╮")
    : color("╭" + "─".repeat(inner) + "╮");
  const bot = color("╰" + "─".repeat(inner) + "╯");
  const body = lines.map((l) => color("│ ") + pad(l, contentW) + color(" │"));
  return [top, ...body, bot];
}

// --- prompts ----------------------------------------------------------------
let rawOn = false;
function enableRaw() {
  if (rawOn) return;
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode!(true);
  process.stdin.resume();
  rawOn = true;
}
function disableRaw() {
  if (!rawOn) return;
  process.stdin.setRawMode!(false);
  process.stdin.pause();
  rawOn = false;
}

/** Single-choice arrow-key menu with a styled highlight bar and hint footer. */
function select(message: string, choices: string[], def = 0): Promise<number> {
  if (!isTTY) return Promise.resolve(def);
  let idx = def;
  const n = choices.length;
  const draw = (first: boolean) => {
    if (!first) write(`\x1b[${n + 1}A`);
    for (let i = 0; i < n; i++) {
      write("\x1b[2K");
      const sel = i === idx;
      line(sel ? `  ${t.cyan(SYM.arrow)} ${t.bold(t.cyan(choices[i]!))}` : `    ${t.dim(choices[i]!)}`);
    }
    write("\x1b[2K");
    line(t.gray("    ↑/↓ move · ⏎ select · esc cancel"));
  };
  line(t.bold(message));
  draw(true);
  enableRaw();
  return new Promise((resolve) => {
    const onKey = (_s: string, k: readline.Key) => {
      if (k.name === "up" || (k.ctrl && k.name === "p")) { idx = (idx - 1 + n) % n; draw(false); }
      else if (k.name === "down" || (k.ctrl && k.name === "n")) { idx = (idx + 1) % n; draw(false); }
      else if (k.name === "return") { process.stdin.removeListener("keypress", onKey); disableRaw(); resolve(idx); }
      else if (k.name === "escape" || (k.ctrl && k.name === "c")) { disableRaw(); line(); process.exit(130); }
    };
    process.stdin.on("keypress", onKey);
  });
}

interface Choice { label: string; checked: boolean; hint?: string }

/** Checkbox multiselect: ↑/↓ move, space toggle, a all, ⏎ confirm. */
function multiselect(message: string, items: Choice[]): Promise<Choice[]> {
  if (!isTTY) return Promise.resolve(items);
  let idx = 0;
  const n = items.length;
  const draw = (first: boolean) => {
    if (!first) write(`\x1b[${n + 1}A`);
    for (let i = 0; i < n; i++) {
      write("\x1b[2K");
      const it = items[i]!;
      const cursor = i === idx ? t.cyan(SYM.arrow) : " ";
      const mark = it.checked ? t.green(SYM.on) : t.dim(SYM.off);
      const label = i === idx ? t.bold(it.label) : it.label;
      const hint = it.hint ? t.gray("  " + it.hint) : "";
      line(`  ${cursor} ${mark} ${label}${hint}`);
    }
    write("\x1b[2K");
    line(t.gray("    ↑/↓ move · space toggle · a all · ⏎ confirm"));
  };
  line(t.bold(message));
  draw(true);
  enableRaw();
  return new Promise((resolve) => {
    const onKey = (_s: string, k: readline.Key) => {
      if (k.name === "up") { idx = (idx - 1 + n) % n; draw(false); }
      else if (k.name === "down") { idx = (idx + 1) % n; draw(false); }
      else if (k.name === "space") { items[idx]!.checked = !items[idx]!.checked; draw(false); }
      else if (k.name === "a") { const all = items.every((x) => x.checked); items.forEach((x) => (x.checked = !all)); draw(false); }
      else if (k.name === "return") { process.stdin.removeListener("keypress", onKey); disableRaw(); resolve(items); }
      else if (k.name === "escape" || (k.ctrl && k.name === "c")) { disableRaw(); line(); process.exit(130); }
    };
    process.stdin.on("keypress", onKey);
  });
}

// --- step runner ------------------------------------------------------------
interface Step { label: string; run: () => string | null; }

/** Run steps sequentially, revealing a live checklist with per-step timing. */
async function runChecklist(steps: Step[]): Promise<void> {
  for (const s of steps) {
    if (isTTY) { write(`\x1b[2K  ${t.yellow(SYM.run)} ${s.label}…\r`); await sleep(90); }
    const start = process.hrtime.bigint();
    let detail: string | null;
    try { detail = s.run(); }
    catch (e) {
      if (isTTY) write("\x1b[2K");
      line(`  ${t.red(SYM.no)} ${s.label} ${t.red("— " + (e as Error).message)}`);
      continue;
    }
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    if (isTTY) write("\x1b[2K");
    if (detail === null) line(`  ${t.dim(SYM.dot)} ${t.dim(s.label + " — skipped")}`);
    else line(`  ${t.green(SYM.ok)} ${s.label}${detail ? "  " + t.gray(detail) : ""}${t.gray(`  ${ms.toFixed(0)}ms`)}`);
  }
}

// --- detection --------------------------------------------------------------
function hasClaude(): boolean {
  try { execFileSync("claude", ["--version"], { stdio: "ignore" }); return true; }
  catch { return false; }
}
function wireClaudeMcp(): "added" | "exists" | "unavailable" {
  if (!hasClaude()) return "unavailable";
  try { execFileSync("claude", ["mcp", "get", "cairn"], { stdio: "ignore" }); return "exists"; }
  catch { /* not present — add it */ }
  try {
    execFileSync("claude", ["mcp", "add", "-s", "user", "cairn", "--", "cairn", "mcp"], { stdio: "ignore" });
    return "added";
  } catch { return "exists"; }
}
function detectedAgents(home: string): string[] {
  return GLOBAL_AGENT_FILES
    .filter((f) => f.agent !== "generic" && existsSync(join(home, f.dir)))
    .map((f) => f.agent);
}

// --- main -------------------------------------------------------------------
export async function runQuickstart(cwd: string): Promise<void> {
  const home = homedir();
  const claudePresent = hasClaude();
  const kind: RepoKind = classifyRepo(cwd);
  const projectName = (() => {
    try { return JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).name ?? cwd.split("/").pop(); }
    catch { return cwd.split("/").pop() || cwd; }
  })();
  const agents = detectedAgents(home);

  // Header banner.
  line();
  for (const l of box(
    [
      t.bold(t.cyan("⛰  CAIRN")) + t.dim("   shared, git-like memory for AI agents") + t.gray("   " + VERSION),
    ],
    { width: 64, color: t.cyan },
  )) line("  " + l);

  // Context panel.
  line();
  for (const l of box(
    [
      `${t.dim("repo")}     ${t.bold(String(projectName))}  ${t.gray("(" + kind + ")")}`,
      `${t.dim("agents")}   ${agents.length ? agents.map((a) => t.green(a)).join(t.gray(", ")) : t.dim("none detected")}`,
      `${t.dim("claude")}   ${claudePresent ? t.green("CLI found — MCP can auto-register") : t.dim("CLI not found")}`,
    ],
    { title: "Detected", width: 64 },
  )) line("  " + l);
  line();

  if (!isTTY) line(t.dim("  (no TTY — applying recommended defaults)"));

  const mode = await select(
    "How would you like to set up Cairn?",
    [
      "Recommended — wire everything (global + repo + hook + index" + (claudePresent ? " + MCP)" : ")"),
      "Customize — choose each component",
      "Cancel",
    ],
    0,
  );
  if (mode === 2) { line(t.dim("\n  Cancelled. Nothing changed.\n")); return; }

  let doGlobal = true, all = false, gitHook = true, buildIndex = true, doMcp = claudePresent;
  if (mode === 1) {
    line();
    const picks = await multiselect("Select components (space to toggle):", [
      { label: "Global agent bootstrap", checked: true, hint: "~/.claude, ~/.codex …" },
      { label: "All agent files in this repo", checked: false, hint: "not just the primary ones" },
      { label: "Git post-commit hook", checked: true, hint: "auto-capture commits" },
      { label: "Build code graph now", checked: true, hint: "powers `cairn relevant`" },
      { label: "Register Claude Code MCP", checked: claudePresent, hint: claudePresent ? "claude mcp add" : "claude CLI not found" },
    ]);
    doGlobal = picks[0]!.checked; all = picks[1]!.checked; gitHook = picks[2]!.checked;
    buildIndex = picks[3]!.checked; doMcp = picks[4]!.checked && claudePresent;
  }

  // Execute as an animated checklist. (Holder object so TS keeps the result
  // types across the callback mutations.)
  line();
  line(t.bold("  Setting up…"));
  const st: { proj: SetupResult | null; mcp: "added" | "exists" | "unavailable" } = { proj: null, mcp: "unavailable" };
  await runChecklist([
    {
      label: "Global agent bootstrap",
      run: () => {
        if (!doGlobal) return null;
        const g = installGlobal({ all });
        const n = g.filesCreated.length + g.filesUpdated.length;
        return n ? `${n} file(s)` : "already current";
      },
    },
    {
      label: "Project journal + agent rules",
      run: () => {
        st.proj = setupProject(cwd, { all, gitHook, buildIndex });
        const n = st.proj.filesCreated.length + st.proj.filesUpdated.length;
        return `journal + ${n} agent file(s)`;
      },
    },
    { label: "Git auto-capture hook", run: () => (st.proj?.gitHook ? "post-commit" : null) },
    { label: "Code graph index", run: () => (st.proj && st.proj.filesIndexed > 0 ? `${st.proj.filesIndexed} files` : (buildIndex ? "no source yet" : null)) },
    {
      label: "Claude Code MCP server",
      run: () => {
        if (!doMcp) return null;
        st.mcp = wireClaudeMcp();
        return st.mcp === "added" ? "registered" : st.mcp === "exists" ? "already registered" : "claude CLI not found";
      },
    },
  ]);

  // Summary card.
  line();
  const taught = st.proj ? st.proj.filesCreated.length + st.proj.filesUpdated.length : 0;
  const mcpWired = doMcp && st.mcp !== "unavailable";
  const summary = [
    `${t.green(SYM.ok)} journal ready      ${t.gray(".agent/")}`,
    `${t.green(SYM.ok)} agents taught      ${t.bold(String(taught))}`,
    `${t.green(SYM.ok)} code graph         ${t.bold(String(st.proj?.filesIndexed ?? 0))} files`,
    `${mcpWired ? t.green(SYM.ok) : t.dim(SYM.dot)} Claude Code MCP    ${mcpWired ? t.bold("wired") : t.dim("skipped")}`,
  ];
  for (const l of box(summary, { title: "Ready", width: 64, color: t.green })) line("  " + l);

  line();
  line("  " + t.bold("Next:"));
  line(`    ${t.cyan("cairn recall")}            ${t.gray("start every session here")}`);
  line(`    ${t.cyan('cairn anchor "<fact>"')}   ${t.gray("pin a fact into every context")}`);
  if (mcpWired && st.mcp === "added") line(`    ${t.yellow("restart Claude Code")}     ${t.gray("so the MCP + context hook load")}`);
  line();
}
