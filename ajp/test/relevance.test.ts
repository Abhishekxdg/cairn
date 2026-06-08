import { describe, it, expect, afterEach } from "vitest";
import { memStore, cleanupAll } from "./helpers.js";
import type { EventStore } from "../src/core/store.js";
import { tokenize, buildCorpus, rankFiles, compileTaskContext } from "../src/engines/relevance.js";

afterEach(cleanupAll);

/** Seed a store with a commit: one git.commit + one file.* per path. */
function commit(
  store: EventStore,
  sha: string,
  message: string,
  files: string[],
  ts: string,
  type: "file.created" | "file.modified" | "file.deleted" = "file.modified",
): void {
  store.appendEvent({ type: "git.commit", timestamp: ts, payload: { commit: sha, message } });
  for (const path of files) {
    store.appendEvent({ type, timestamp: ts, actor: "dev", payload: { commit: sha, path, owner: "dev" } });
  }
}

describe("tokenize", () => {
  it("splits camelCase and snake_case", () => {
    expect(tokenize("paymentRetry")).toEqual(["payment", "retry"]);
    expect(tokenize("retry_handler")).toEqual(["retry", "handler"]);
  });

  it("drops conventional-commit prefixes, stopwords, and 1-char tokens", () => {
    const t = tokenize("feat: add the retry to gateway");
    expect(t).not.toContain("feat");
    expect(t).not.toContain("the");
    expect(t).not.toContain("add"); // stopword
    expect(t).toContain("retry");
    expect(t).toContain("gateway");
  });

  it("folds simple plurals/gerunds to a common stem", () => {
    expect(tokenize("charges")).toEqual(tokenize("charge"));
    expect(tokenize("tracking")).toEqual(tokenize("track"));
  });
});

describe("buildCorpus", () => {
  it("groups file events under their commit's intent", () => {
    const s = memStore();
    commit(s, "a1", "implement payment retry", ["src/pay.ts", "src/retry.ts"], "2025-01-01T00:00:00Z");
    const corpus = buildCorpus(s);
    s.close();
    expect(corpus).toHaveLength(1);
    expect(corpus[0]!.commit).toBe("a1");
    expect(corpus[0]!.files.map((f) => f.path).sort()).toEqual(["src/pay.ts", "src/retry.ts"]);
    expect(corpus[0]!.tokens).toContain("payment");
  });

  it("drops files whose latest event is a deletion", () => {
    const s = memStore();
    commit(s, "a1", "add module", ["src/keep.ts", "src/gone.ts"], "2025-01-01T00:00:00Z", "file.created");
    commit(s, "a2", "remove module", ["src/gone.ts"], "2025-01-02T00:00:00Z", "file.deleted");
    const corpus = buildCorpus(s);
    s.close();
    const paths = corpus.flatMap((d) => d.files.map((f) => f.path));
    expect(paths).toContain("src/keep.ts");
    expect(paths).not.toContain("src/gone.ts");
  });
});

describe("rankFiles", () => {
  it("is deterministic — identical input yields identical ranking", () => {
    const s = memStore();
    commit(s, "a1", "alpha feature work", ["src/mod0.ts", "pkg.json"], "2025-01-01T00:00:00Z");
    commit(s, "a2", "bravo feature work", ["src/mod1.ts", "pkg.json"], "2025-01-02T00:00:00Z");
    const r1 = rankFiles(s, "alpha feature", { now: Date.parse("2025-02-01T00:00:00Z") });
    const r2 = rankFiles(s, "alpha feature", { now: Date.parse("2025-02-01T00:00:00Z") });
    s.close();
    expect(r1.map((f) => f.path)).toEqual(r2.map((f) => f.path));
  });

  it("fileIDF demotes a high-churn file below the topical file", () => {
    const s = memStore();
    const now = Date.parse("2025-02-01T00:00:00Z");
    // 'pkg.json' is touched by EVERY commit (pure churn); each domain file once.
    for (let i = 0; i < 12; i++) {
      const dom = ["alpha", "bravo", "charlie"][i % 3]!;
      commit(s, `c${i}`, `work on ${dom} subsystem`, [`src/${dom}.ts`, "pkg.json"], new Date(now - i * 3600_000).toISOString());
    }
    const ranked = rankFiles(s, "alpha subsystem", { now, k: 5 });
    s.close();
    const alphaRank = ranked.findIndex((f) => f.path === "src/alpha.ts");
    const churnRank = ranked.findIndex((f) => f.path === "pkg.json");
    expect(alphaRank).toBeGreaterThanOrEqual(0);
    expect(alphaRank).toBeLessThan(churnRank === -1 ? Infinity : churnRank); // topical file wins
    expect(ranked[0]!.path).toBe("src/alpha.ts");
  });

  it("returns an empty list for an empty corpus", () => {
    const s = memStore();
    const ranked = rankFiles(s, "anything");
    s.close();
    expect(ranked).toEqual([]);
  });
});

describe("rankFiles — cold start (no git history, index only)", () => {
  it("surfaces a file by its exported symbol with zero commits", () => {
    const s = memStore();
    s.appendEvent({ type: "code.indexed", payload: { path: "src/payment.ts", lang: "js-ts", imports: [], exports: ["paymentService", "chargeCard"] } });
    s.appendEvent({ type: "code.indexed", payload: { path: "src/auth.ts", lang: "js-ts", imports: [], exports: ["loginUser"] } });
    const ranked = rankFiles(s, "payment charge flow", { k: 3 });
    s.close();
    expect(ranked[0]!.path).toBe("src/payment.ts");
    expect(ranked[0]!.why).toMatch(/exports/);
  });

  it("surfaces an opaque helper purely via import proximity", () => {
    const s = memStore();
    // helper has NO matching symbol; it is reachable only because the matched
    // file imports it.
    s.appendEvent({ type: "code.indexed", payload: { path: "src/payment.ts", lang: "js-ts", imports: ["src/util42.ts"], exports: ["paymentService"] } });
    s.appendEvent({ type: "code.indexed", payload: { path: "src/util42.ts", lang: "js-ts", imports: [], exports: ["zztop"] } });
    s.appendEvent({ type: "code.indexed", payload: { path: "src/auth.ts", lang: "js-ts", imports: [], exports: ["loginUser"] } });
    const ranked = rankFiles(s, "payment service", { k: 3 });
    s.close();
    const paths = ranked.map((f) => f.path);
    expect(paths).toContain("src/util42.ts"); // surfaced by proximity, not symbol
    expect(paths.indexOf("src/payment.ts")).toBeLessThan(paths.indexOf("src/util42.ts"));
  });
});

describe("compileTaskContext", () => {
  it("augments base context with relevant files and the related decision", () => {
    const s = memStore();
    s.appendEvent({ type: "goal.created", payload: { id: "g1", title: "Ship v1" } });
    s.appendEvent({ type: "decision.made", payload: { id: "d1", title: "Use exponential backoff for retry", rationale: "avoid thundering herd" } });
    commit(s, "a1", "implement retry backoff", ["src/retry.ts"], "2025-01-01T00:00:00Z");
    const ctx = compileTaskContext(s, "retry backoff", { now: Date.parse("2025-02-01T00:00:00Z") });
    s.close();
    expect(ctx.task).toBe("retry backoff");
    expect(ctx.goal).toBe("Ship v1");
    expect(ctx.relevantFiles.map((f) => f.path)).toContain("src/retry.ts");
    expect(ctx.relatedDecisions.map((d) => d.id)).toContain("d1");
  });
});
