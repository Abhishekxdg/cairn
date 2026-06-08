import { describe, it, expect, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, cleanupAll } from "./helpers.js";
import { setupProject, ajpInvocation } from "../src/setup/install.js";
import { EventStore } from "../src/core/store.js";
import { writeContextFile, renderRecall } from "../src/engines/recall.js";
import { compileContext } from "../src/engines/context.js";

afterAll(cleanupAll);

describe("instant recall (.agent/CONTEXT.md)", () => {
  it("setup writes a CONTEXT.md and PATH-independent rules", () => {
    const dir = tempDir();
    setupProject(dir);
    expect(existsSync(join(dir, ".agent", "CONTEXT.md"))).toBe(true);

    // Rules embed the absolute node invocation so agents work without PATH.
    const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(agents).toContain("CONTEXT.md");
    expect(agents).toContain("ajp recall");
    expect(agents).toContain(ajpInvocation()); // node <abs>/bin/ajp.js fallback
  });

  it("CONTEXT.md reflects current state and refreshes on change", () => {
    const dir = tempDir();
    setupProject(dir);
    const store = new EventStore(join(dir, ".agent", "journal.db"));
    store.appendEvent({ type: "goal.created", payload: { id: "g1", title: "Ship it" } });
    store.appendEvent({ type: "decision.made", payload: { id: "d1", title: "Use SQLite", rationale: "WAL" } });
    writeContextFile(store, dir);

    const md = readFileSync(join(dir, ".agent", "CONTEXT.md"), "utf8");
    expect(md).toContain("Goal: Ship it");
    expect(md).toContain("Use SQLite — WAL");
    expect(md).toContain("Where we are");
    store.close();
  });

  it("renderRecall is compact and tool-free to read", () => {
    const dir = tempDir();
    setupProject(dir);
    const store = new EventStore(join(dir, ".agent", "journal.db"));
    const text = renderRecall(compileContext(store, { level: "small" }));
    expect(text.length).toBeLessThan(2000); // small enough to read instantly
    expect(text).toContain("Next:");
    store.close();
  });
});
