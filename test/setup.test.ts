import { describe, it, expect, afterAll } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tempDir, cleanupAll } from "./helpers.js";
import { execFileSync } from "node:child_process";
import { setupProject, upsertBlock, AGENT_FILES, installSessionHook, installChatHooks, CHAT_HOOK_MARKER, SESSION_HOOK_MARKER, classifyRepo } from "../src/setup/install.js";
import { BEGIN_MARKER, END_MARKER } from "../src/setup/rules.js";

/** Make `dir` a git repo with one commit, so it classifies as "existing". */
function gitRepoWithCommit(dir: string): void {
  const run = (args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  run(["init"]);
  run(["config", "user.email", "t@t.dev"]);
  run(["config", "user.name", "t"]);
  writeFileSync(join(dir, "a.js"), "export const x = 1;\n");
  run(["add", "-A"]);
  run(["commit", "-m", "init", "--no-verify"]);
}

afterAll(cleanupAll);

describe("project setup (auto-install for agents)", () => {
  it("creates the journal and primary agent files", () => {
    const dir = tempDir();
    const r = setupProject(dir);
    expect(r.initializedJournal).toBe(true);
    expect(existsSync(join(dir, ".agent", "journal.db"))).toBe(true);
    // Primary files created.
    expect(r.filesCreated).toContain("AGENTS.md");
    expect(r.filesCreated).toContain("CLAUDE.md");
    const claude = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    expect(claude).toContain(BEGIN_MARKER);
    expect(claude).toContain("cairn context");
    expect(claude).toContain(END_MARKER);
  });

  it("does not create secondary files unless they exist (or --all)", () => {
    const dir = tempDir();
    setupProject(dir);
    expect(existsSync(join(dir, ".cursorrules"))).toBe(false);
    expect(existsSync(join(dir, "GEMINI.md"))).toBe(false);

    const all = tempDir();
    setupProject(all, { all: true });
    expect(existsSync(join(all, ".cursorrules"))).toBe(true);
    expect(existsSync(join(all, ".github", "copilot-instructions.md"))).toBe(true);
  });

  it("updates an EXISTING secondary file, preserving its content", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".cursorrules"), "# My existing Cursor rules\nBe concise.\n");
    const r = setupProject(dir);
    expect(r.filesUpdated).toContain(".cursorrules");
    const content = readFileSync(join(dir, ".cursorrules"), "utf8");
    expect(content).toContain("My existing Cursor rules"); // human content kept
    expect(content).toContain(BEGIN_MARKER); // Cairn block appended
  });

  it("is idempotent — re-running replaces the block in place", () => {
    const dir = tempDir();
    setupProject(dir);
    const first = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    const r2 = setupProject(dir);
    const second = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    expect(second).toBe(first); // no change → no churn
    expect(r2.filesCreated).not.toContain("CLAUDE.md");
    // Only one block (no duplication).
    expect(second.split(BEGIN_MARKER).length - 1).toBe(1);
  });

  it("upsertBlock replaces an old block and keeps surrounding text", () => {
    const original = `# Title\n\n${BEGIN_MARKER}\nOLD RULES\n${END_MARKER}\n\n## Footer\n`;
    const { content, updated } = upsertBlock(original);
    expect(updated).toBe(true);
    expect(content).toContain("# Title");
    expect(content).toContain("## Footer");
    expect(content).not.toContain("OLD RULES");
    expect(content.split(BEGIN_MARKER).length - 1).toBe(1);
  });

  it("installs an auto-recall SessionStart hook into .claude/settings.json", () => {
    const dir = tempDir();
    const r = setupProject(dir);
    expect(r.sessionHook).toBe(true);
    const settings = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
    const cmds = settings.hooks.SessionStart.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(cmds.some((c: string) => c.includes("CAIRN:recall-inject"))).toBe(true);
    expect(cmds.some((c: string) => c.includes("CONTEXT.md"))).toBe(true);
  });

  it("session hook merge is idempotent and preserves existing settings", () => {
    const dir = tempDir();
    const dotClaude = join(dir, ".claude");
    mkdirSync(dotClaude, { recursive: true });
    // Pre-existing user settings + an unrelated SessionStart hook.
    writeFileSync(
      join(dotClaude, "settings.json"),
      JSON.stringify({ model: "opus", hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] } }, null, 2),
    );
    installSessionHook(dir);
    installSessionHook(dir); // twice → still one Cairn entry
    const s = JSON.parse(readFileSync(join(dotClaude, "settings.json"), "utf8"));
    expect(s.model).toBe("opus"); // unrelated setting preserved
    const cmds = s.hooks.SessionStart.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(cmds.filter((c: string) => c.includes("CAIRN:recall-inject")).length).toBe(1);
    expect(cmds.some((c: string) => c === "echo hi")).toBe(true); // user hook kept
  });

  it("covers the known agent ecosystem", () => {
    const paths = AGENT_FILES.map((f) => f.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "AGENTS.md",
        "CLAUDE.md",
        "GEMINI.md",
        ".cursorrules",
        ".github/copilot-instructions.md",
      ]),
    );
  });
});

describe("repo classification + code-graph build", () => {
  it("classifies a fresh dir as new", () => {
    expect(classifyRepo(tempDir())).toBe("new");
  });

  it("classifies a commit-less git repo as new", () => {
    const dir = tempDir();
    execFileSync("git", ["-C", dir, "init"], { stdio: "ignore" });
    expect(classifyRepo(dir)).toBe("new");
  });

  it("classifies a git repo WITH commits as existing", () => {
    const dir = tempDir();
    gitRepoWithCommit(dir);
    expect(classifyRepo(dir)).toBe("existing");
  });

  it("classifies an already-initialized repo as initialized (consent implied)", () => {
    const dir = tempDir();
    gitRepoWithCommit(dir);
    setupProject(dir); // creates .agent/
    expect(classifyRepo(dir)).toBe("initialized");
  });

  it("does not build the code graph by default", () => {
    const dir = tempDir();
    gitRepoWithCommit(dir);
    const r = setupProject(dir);
    expect(r.filesIndexed).toBe(0);
  });

  it("builds the code graph when buildIndex is set", () => {
    const dir = tempDir();
    gitRepoWithCommit(dir);
    const r = setupProject(dir, { buildIndex: true });
    expect(r.filesIndexed).toBeGreaterThan(0);
  });
});

describe("chat hooks (Claude Code)", () => {
  it("writes Stop + SessionStart chat hooks once, idempotently", () => {
    const dir = tempDir();
    setupProject(dir);
    installChatHooks(dir);
    installChatHooks(dir); // second run must not duplicate
    const settings = JSON.parse(
      readFileSync(join(dir, ".claude", "settings.json"), "utf8"),
    );
    const stop = settings.hooks.Stop as Array<{ hooks: Array<{ command: string }> }>;
    const marked = stop.flatMap((g) => g.hooks).filter((h) => h.command.includes(CHAT_HOOK_MARKER));
    expect(marked).toHaveLength(1);
    expect(marked[0]!.command).toContain("chat inbox");
  });

  it("preserves the SessionStart recall hook when chat hooks are installed", () => {
    const dir = tempDir();
    setupProject(dir); // installs the recall hook (and chat hooks)
    installChatHooks(dir); // re-run must not clobber recall
    const settings = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
    const start = settings.hooks.SessionStart as Array<{ hooks: Array<{ command: string }> }>;
    const cmds = start.flatMap((g) => g.hooks).map((h) => h.command);
    // Both the recall hook and the chat-tail hook coexist on SessionStart.
    expect(cmds.some((c) => c.includes(SESSION_HOOK_MARKER))).toBe(true);
    expect(cmds.some((c) => c.includes(CHAT_HOOK_MARKER))).toBe(true);
  });
});
