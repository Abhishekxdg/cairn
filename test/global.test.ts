import { describe, it, expect, afterAll } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tempDir, cleanupAll } from "./helpers.js";
import { installGlobal, uninstallGlobal } from "../src/setup/global.js";
import { GLOBAL_BEGIN_MARKER, GLOBAL_END_MARKER } from "../src/setup/rules.js";

afterAll(cleanupAll);

describe("global bootstrap (install once, agents self-setup projects)", () => {
  it("writes primary global files into a fresh home", () => {
    const home = tempDir();
    const r = installGlobal({ home });
    expect(r.filesCreated).toContain(".claude/CLAUDE.md");
    const claude = readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8");
    expect(claude).toContain(GLOBAL_BEGIN_MARKER);
    expect(claude).toContain("cairn setup");
    expect(claude).toContain("no `.agent/` directory exists");
  });

  it("creates a tool's file when its config dir already exists", () => {
    const home = tempDir();
    mkdirSync(join(home, ".gemini"), { recursive: true }); // user uses Gemini
    const r = installGlobal({ home });
    expect(r.filesCreated).toContain(".gemini/GEMINI.md");
  });

  it("skips tools whose config dir is absent (unless --all)", () => {
    const home = tempDir();
    installGlobal({ home });
    expect(existsSync(join(home, ".gemini", "GEMINI.md"))).toBe(false);

    const home2 = tempDir();
    installGlobal({ home: home2, all: true });
    expect(existsSync(join(home2, ".gemini", "GEMINI.md"))).toBe(true);
    expect(existsSync(join(home2, ".codex", "AGENTS.md"))).toBe(true);
  });

  it("preserves existing global content and is idempotent", () => {
    const home = tempDir();
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "# My global prefs\nBe terse.\n");

    const r1 = installGlobal({ home });
    expect(r1.filesUpdated).toContain(".claude/CLAUDE.md");
    const c1 = readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8");
    expect(c1).toContain("My global prefs");
    expect(c1).toContain(GLOBAL_BEGIN_MARKER);

    const c0 = readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8");
    installGlobal({ home });
    const c2 = readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8");
    expect(c2).toBe(c0); // no churn
    expect(c2.split(GLOBAL_BEGIN_MARKER).length - 1).toBe(1); // single block
  });

  it("uninstall removes the block but keeps human content", () => {
    const home = tempDir();
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "# Keep me\n");
    installGlobal({ home });
    const removed = uninstallGlobal({ home });
    expect(removed.filesUpdated).toContain(".claude/CLAUDE.md");
    const after = readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8");
    expect(after).toContain("Keep me");
    expect(after).not.toContain(GLOBAL_BEGIN_MARKER);
    expect(after).not.toContain(GLOBAL_END_MARKER);
  });
});
