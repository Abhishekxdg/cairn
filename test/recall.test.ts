import { describe, it, expect, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, cleanupAll } from "./helpers.js";
import { setupProject, cairnInvocation } from "../src/setup/install.js";
import { EventStore } from "../src/core/store.js";
import { writeContextFile, renderRecall } from "../src/engines/recall.js";
import { compileContext } from "../src/engines/context.js";
import { estimateTokens } from "../src/engines/tokens.js";

afterAll(cleanupAll);

describe("instant recall (.agent/CONTEXT.md)", () => {
  it("setup writes a CONTEXT.md and PATH-independent rules", () => {
    const dir = tempDir();
    setupProject(dir);
    expect(existsSync(join(dir, ".agent", "CONTEXT.md"))).toBe(true);

    // Rules embed the absolute node invocation so agents work without PATH.
    const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(agents).toContain("CONTEXT.md");
    expect(agents).toContain("cairn recall");
    expect(agents).toContain(cairnInvocation()); // node <abs>/bin/cairn.js fallback
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

  it("enforces a hard token budget by dropping low-value sections", () => {
    const dir = tempDir();
    setupProject(dir);
    const store = new EventStore(join(dir, ".agent", "journal.db"));
    store.appendEvent({ type: "goal.created", payload: { id: "g1", title: "Ship OAuth login" } });
    // Flood the journal so recent-activity would blow any small budget.
    for (let i = 0; i < 80; i++) {
      store.appendEvent({
        type: "knowledge.learned",
        payload: { statement: `fact number ${i} with enough words to cost real tokens here` },
      });
    }
    const ctx = compileContext(store, { level: "large" });
    const tight = renderRecall(ctx, { budget: 120 });
    expect(estimateTokens(tight)).toBeLessThanOrEqual(120);
    // The spine survives even under pressure.
    expect(tight).toContain("Goal: Ship OAuth login");
    // Footer reports the realized token count.
    expect(tight).toMatch(/~\d+ tokens/);
    store.close();
  });

  it("tags decisions with provenance (id + age) so agents can trust them", () => {
    const dir = tempDir();
    setupProject(dir);
    const store = new EventStore(join(dir, ".agent", "journal.db"));
    store.appendEvent({
      type: "decision.made",
      payload: { id: "d1", title: "Use Google OAuth", rationale: "users have Google" },
      timestamp: "2026-06-01T00:00:00.000Z",
    });
    const ctx = compileContext(store, { level: "small", now: Date.parse("2026-06-09T00:00:00.000Z") });
    const text = renderRecall(ctx);
    expect(text).toMatch(/Use Google OAuth.*\(d1 · \d+d\)/); // id + an age like "8d"
    store.close();
  });

  it("stamps a drift signal when commits have moved past the context", () => {
    const dir = tempDir();
    setupProject(dir);
    const store = new EventStore(join(dir, ".agent", "journal.db"));
    const text = renderRecall(compileContext(store, { level: "small" }), { driftCommits: 3 });
    expect(text).toContain("3 commits since");
    store.close();
  });
});
