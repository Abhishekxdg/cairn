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

  it("carries anchors into recall and never drops them under budget pressure", () => {
    const dir = tempDir();
    setupProject(dir);
    const store = new EventStore(join(dir, ".agent", "journal.db"));
    store.appendEvent({ type: "goal.created", payload: { id: "g1", title: "Ship OAuth" } });
    // Anchored decision + durable fact must always survive.
    store.appendEvent({
      type: "decision.made",
      payload: { id: "d1", title: "Use PKCE", rationale: "public client", anchor: true },
    });
    store.appendEvent({
      type: "knowledge.learned",
      payload: { id: "k1", statement: "redirect URIs must be allowlisted", anchor: true },
    });
    // Flood with low-value activity that would blow a tiny budget.
    for (let i = 0; i < 80; i++) {
      store.appendEvent({
        type: "knowledge.learned",
        payload: { statement: `noise fact ${i} with enough words to cost real tokens here` },
      });
    }
    const ctx = compileContext(store, { level: "large" });
    expect(ctx.anchors.map((a) => a.kind).sort()).toEqual(["decision", "knowledge"]);

    const tight = renderRecall(ctx, { budget: 80 });
    // Both anchors survive even when the budget is brutally small.
    expect(tight).toContain("Anchors:");
    expect(tight).toContain("Use PKCE — public client");
    expect(tight).toContain("redirect URIs must be allowlisted");

    // At a comfortable budget the anchored decision shows once (in Anchors), not
    // duplicated in the droppable decisions list.
    const full = renderRecall(ctx, { budget: 1500 });
    expect(full).toContain("(all anchored — see Anchors)");
    // The decisions list never re-prints the anchored decision with its id tag.
    expect(full).not.toContain("(d1");
    store.close();
  });

  it("rations the anchor budget: keeps highest-weight pins, collapses the tail", () => {
    const dir = tempDir();
    setupProject(dir);
    const store = new EventStore(join(dir, ".agent", "journal.db"));
    store.appendEvent({ type: "goal.created", payload: { id: "g1", title: "Ship" } });
    // 60 anchored facts with increasing weight; only a fraction fit the budget.
    for (let i = 0; i < 60; i++) {
      store.appendEvent({
        type: "knowledge.learned",
        payload: { id: `a${i}`, statement: `pinned fact number ${i} carrying real token weight`, anchor: true, weight: i },
      });
    }
    const ctx = compileContext(store, { level: "large" });
    // Ranked highest-weight first.
    expect(ctx.anchors[0]?.text).toContain("number 59");

    const text = renderRecall(ctx, { budget: 400 });
    // Budget is respected even though 60 pins would overflow it.
    expect(estimateTokens(text)).toBeLessThanOrEqual(400);
    // The top-weighted pin is present; a low-weighted one is not.
    expect(text).toContain("pinned fact number 59");
    expect(text).not.toContain("pinned fact number 0 ");
    // The overflow is summarized, not silently dropped.
    expect(text).toMatch(/…\+\d+ more anchored/);
    store.close();
  });

  it("keeps the top-ranked anchor at a tight budget, and stays within budget", () => {
    const dir = tempDir();
    setupProject(dir);
    const store = new EventStore(join(dir, ".agent", "journal.db"));
    store.appendEvent({ type: "goal.created", payload: { id: "g1", title: "Ship" } });
    for (let i = 0; i < 20; i++) {
      store.appendEvent({
        type: "knowledge.learned",
        payload: { id: `a${i}`, statement: `pinned fact ${i} with enough words to cost tokens`, anchor: true, weight: i },
      });
    }
    const text = renderRecall(compileContext(store, { level: "large" }), { budget: 120 });
    expect(text).toContain("pinned fact 19"); // highest weight kept
    expect(text).not.toContain("pinned fact 0 "); // lowest weight rationed out
    expect(text).toMatch(/…\+\d+ more anchored/);
    expect(estimateTokens(text)).toBeLessThanOrEqual(120); // budget is hard
    store.close();
  });

  it("budget is hard down to a tiny skeleton floor even when the spine overflows", () => {
    const dir = tempDir();
    setupProject(dir);
    const store = new EventStore(join(dir, ".agent", "journal.db"));
    store.appendEvent({ type: "goal.created", payload: { id: "g1", title: "Ship something" } });
    // Many heavy anchors would overflow any tiny budget if they were sacrosanct.
    for (let i = 0; i < 40; i++) {
      store.appendEvent({
        type: "knowledge.learned",
        payload: { id: `a${i}`, statement: `pinned fact ${i} with a long descriptive sentence`, anchor: true, weight: i },
      });
    }
    const ctx = compileContext(store, { level: "full" });
    for (const budget of [40, 80, 200]) {
      expect(estimateTokens(renderRecall(ctx, { budget }))).toBeLessThanOrEqual(budget);
    }
    store.close();
  });

  it("clips an oversized goal so the spine cannot blow the token budget", () => {
    const dir = tempDir();
    setupProject(dir);
    const store = new EventStore(join(dir, ".agent", "journal.db"));
    store.appendEvent({ type: "goal.created", payload: { id: "g1", title: "x".repeat(5000) } });
    const text = renderRecall(compileContext(store, { level: "small" }), { budget: 1500 });
    expect(text).toContain("…"); // goal was clipped
    expect(estimateTokens(text)).toBeLessThanOrEqual(1500);
    // Even rendered with no budget, the clipped spine stays small (< 120t floor).
    expect(estimateTokens(renderRecall(compileContext(store, { level: "small" }), { budget: 0 }))).toBeLessThan(120);
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
