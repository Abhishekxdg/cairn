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
    expect(stripAnsi(banner())).toContain("Cairn");
  });

  it("step shows a check and label", () => {
    expect(stripAnsi(step("done", "note"))).toContain("✓ done");
  });

  it("project setup screen contains the key guidance", () => {
    const dir = tempDir();
    const r = setupProject(dir);
    const screen = stripAnsi(renderProjectSetup(r));
    expect(screen).toContain("Cairn");
    expect(screen).toContain("created shared memory");
    expect(screen).toContain("Claude Code");
    expect(screen).toContain("cairn status");
  });

  it("global setup screen explains the consent-based model", () => {
    const home = tempDir();
    const screen = stripAnsi(renderGlobalSetup(installGlobal({ home })));
    expect(screen).toContain("installed globally");
    expect(screen).toContain("Agents will ask before setting up");
    expect(screen).toContain("cairn uninstall-global");
  });
});
