import { describe, it, expect, afterAll } from "vitest";
import { join } from "node:path";
import { stripAnsi, box, banner, step } from "../src/cli/ui.js";
import { renderProjectSetup, renderGlobalSetup } from "../src/cli/screens.js";
import { setupProject } from "../src/setup/install.js";
import { installGlobal } from "../src/setup/global.js";
import { tempDir, cleanupAll } from "./helpers.js";

afterAll(cleanupAll);

describe("terminal UI", () => {
  it("stripAnsi removes escape codes", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
  });

  it("box lines are all equal visible width (aligned)", () => {
    const out = box("Title", ["short", "a much longer line here"]);
    const bodyLines = out.split("\n").filter((l) => l.includes("│"));
    const widths = new Set(bodyLines.map((l) => stripAnsi(l).length));
    expect(widths.size).toBe(1); // every row aligns to the same width
  });

  it("banner renders without throwing and includes the tagline", () => {
    expect(stripAnsi(banner())).toContain("Agent Journal Protocol");
  });

  it("step shows a check and label", () => {
    expect(stripAnsi(step("done", "note"))).toContain("✓ done");
  });

  it("project setup screen contains the key guidance", () => {
    const dir = tempDir();
    const r = setupProject(dir);
    const screen = stripAnsi(renderProjectSetup(r));
    expect(screen).toContain("Agent Journal Protocol");
    expect(screen).toContain("created shared memory");
    expect(screen).toContain("Claude Code");
    expect(screen).toContain("ajp status");
  });

  it("global setup screen explains the once-forever model", () => {
    const home = tempDir();
    const screen = stripAnsi(renderGlobalSetup(installGlobal({ home })));
    expect(screen).toContain("Installed globally");
    expect(screen).toContain("you never set up a project again");
    expect(screen).toContain("ajp setup");
  });
});
