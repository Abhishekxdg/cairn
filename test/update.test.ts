import { describe, it, expect, afterAll } from "vitest";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { isNewer } from "../src/engines/update.js";
import {
  setupProject,
  refreshProjectRules,
} from "../src/setup/install.js";
import { installGlobal, refreshGlobalRules } from "../src/setup/global.js";
import { parseRulesVersion, RULES_VERSION } from "../src/setup/rules.js";
import { tempDir, cleanupAll } from "./helpers.js";

afterAll(cleanupAll);

describe("update check — version compare", () => {
  it("detects strictly newer versions", () => {
    expect(isNewer("0.2.0", "0.1.9")).toBe(true);
    expect(isNewer("0.1.10", "0.1.9")).toBe(true);
    expect(isNewer("1.0.0", "0.9.9")).toBe(true);
  });
  it("is false for equal or older", () => {
    expect(isNewer("0.1.9", "0.1.9")).toBe(false);
    expect(isNewer("0.1.8", "0.1.9")).toBe(false);
  });
  it("ignores a v prefix and prerelease suffix", () => {
    expect(isNewer("v0.2.0", "0.1.9")).toBe(true);
    expect(isNewer("0.1.9-beta.1", "0.1.9")).toBe(false);
  });
});

describe("self-healing rules", () => {
  it("rewrites a stale (unstamped) project block to the current version", () => {
    const d = tempDir();
    execSync("git init -q", { cwd: d });
    setupProject(d, {});
    const cf = join(d, "CLAUDE.md");

    // The fresh block is stamped current.
    expect(parseRulesVersion(readFileSync(cf, "utf8"))).toBe(RULES_VERSION);

    // Simulate a pre-versioning install by removing the stamp.
    const stripped = readFileSync(cf, "utf8").replace(
      /<!-- cairn-rules-version: \d+ -->\n/,
      "",
    );
    writeFileSync(cf, stripped);
    expect(parseRulesVersion(readFileSync(cf, "utf8"))).toBe(0);

    expect(refreshProjectRules(d)).toContain("CLAUDE.md");
    expect(parseRulesVersion(readFileSync(cf, "utf8"))).toBe(RULES_VERSION);
    // Idempotent: nothing to do the second time.
    expect(refreshProjectRules(d)).toEqual([]);
  });

  it("does not touch files without a Cairn block", () => {
    const d = tempDir();
    writeFileSync(join(d, "AGENTS.md"), "# my own notes\n");
    expect(refreshProjectRules(d)).toEqual([]);
    expect(readFileSync(join(d, "AGENTS.md"), "utf8")).toBe("# my own notes\n");
  });

  it("refreshes a stale global block", () => {
    const home = tempDir();
    mkdirSync(join(home, ".claude"), { recursive: true });
    installGlobal({ home });
    const f = join(home, ".claude", "CLAUDE.md");
    const stripped = readFileSync(f, "utf8").replace(
      /<!-- cairn-rules-version: \d+ -->\n/,
      "",
    );
    writeFileSync(f, stripped);
    expect(refreshGlobalRules({ home })).toContain(".claude/CLAUDE.md");
    expect(parseRulesVersion(readFileSync(f, "utf8"))).toBeGreaterThan(0);
    expect(refreshGlobalRules({ home })).toEqual([]);
  });
});
