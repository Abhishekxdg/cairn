import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tempDir, cleanupAll } from "./helpers.js";

afterAll(cleanupAll);

const BIN = join(process.cwd(), "bin", "cairn.js");
function cairn(dir: string, args: string[]): string {
  return execFileSync("node", [BIN, ...args], { cwd: dir, encoding: "utf8" });
}

describe("cairn chat CLI", () => {
  it("send then inbox delivers across actors", () => {
    const dir = tempDir();
    cairn(dir, ["init", "--no-agents", "--no-index"]);
    cairn(dir, ["chat", "send", "--to", "Codex", "--body", "ping", "--actor", "Claude"]);
    const out = cairn(dir, ["chat", "inbox", "--actor", "Codex"]);
    expect(out).toContain("ping");
    expect(out).toContain("Claude");
  });
});
