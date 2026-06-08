import { describe, it, expect, afterAll } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, cleanupAll } from "./helpers.js";
import { setupProject, upsertBlock, AGENT_FILES } from "../src/setup/install.js";
import { BEGIN_MARKER, END_MARKER } from "../src/setup/rules.js";

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
    expect(claude).toContain("ajp context");
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
    expect(content).toContain(BEGIN_MARKER); // AJP block appended
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
