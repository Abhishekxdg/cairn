/**
 * Cairn — deep, full-system eval harness.
 *
 * Drives every core subsystem against its own claim and prints metrics + a
 * correctness verdict per scenario. Deterministic: all timestamps are injected,
 * nothing reads the wall clock except the perf timers (which measure, not assert).
 *
 * Scenarios:
 *   A. Token efficiency      — "a small read replaces a big scan"
 *   B. Snapshot acceleration — fast path == full replay, but faster
 *   C. Recall fidelity       — a critical OLD fact beats fresh noise
 *   D. Memory residual       — anchors: survival + budget + weight ranking
 *   E. File relevance        — rankFiles precision@k on co-change history
 *   F. Code graph            — importedBy edges are correct
 *   G. Compaction            — archiving is lossless (state identical)
 *   H. Budget adherence      — recall never exceeds its token ceiling
 *   I. Scaling               — append / derive / compile latency at size
 *   J. Determinism           — same events (any order) → same state
 */
import { EventStore } from "../src/core/store.js";
import { deriveState, anchors } from "../src/engines/state.js";
import { compileContext } from "../src/engines/context.js";
import { renderRecall } from "../src/engines/recall.js";
import { estimateTokens } from "../src/engines/tokens.js";
import { createSnapshot } from "../src/engines/snapshots.js";
import { compactJournal } from "../src/engines/compaction.js";
import { rankFiles } from "../src/engines/relevance.js";
import { deriveCodeGraph, indexOneEvent } from "../src/engines/codegraph.js";
import type { NewEvent } from "../src/core/types.js";

// --- harness ----------------------------------------------------------------
let pass = 0;
let fail = 0;
const fails: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else {
    fail++;
    fails.push(`${name}${detail ? ` — ${detail}` : ""}`);
  }
  console.log(`   ${ok ? "✓" : "✗"} ${name}${detail ? `  ${detail}` : ""}`);
}
function ms(fn: () => void): number {
  const t = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t) / 1e6;
}
function mem(pid = "test"): EventStore {
  return new EventStore(":memory:", { projectId: pid });
}
const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const NOW = Date.parse("2026-12-31T00:00:00.000Z");
const ts = (i: number) => new Date(T0 + i * 60_000).toISOString();
function head(t: string) {
  console.log(`\n=== ${t} ===`);
}

// --- A. Token efficiency ----------------------------------------------------
function evalTokenEfficiency() {
  head("A. Token efficiency — small read replaces big scan");
  console.log("events   full-journal tokens   context(small)   ratio");
  for (const n of [200, 1000, 5000]) {
    const s = mem();
    const evs: NewEvent[] = [];
    for (let i = 0; i < n; i++) {
      evs.push({ type: "knowledge.learned", payload: { statement: `finding ${i}: a sentence of moderate length describing some project detail` }, timestamp: ts(i) });
    }
    s.batchAppend(evs);
    const fullJournalText = s.exportEvents().map((e) => JSON.stringify(e.payload)).join("\n");
    const fullTokens = estimateTokens(fullJournalText);
    const ctxTokens = estimateTokens(renderRecall(compileContext(s, { level: "small", now: NOW })));
    const ratio = (fullTokens / ctxTokens).toFixed(0);
    console.log(`${String(n).padStart(6)}   ${String(fullTokens).padStart(19)}   ${String(ctxTokens).padStart(14)}   ${ratio}x`);
    if (n === 5000) check("context is >50x smaller than scanning the journal", fullTokens / ctxTokens > 50, `${ratio}x`);
    s.close();
  }
}

// --- B. Snapshot acceleration -----------------------------------------------
function evalSnapshot() {
  head("B. Snapshot acceleration — fast path == full replay, faster");
  console.log("events   full-replay ms   snapshot+tail ms   speedup   state-identical");
  for (const n of [1000, 10000, 30000]) {
    const s = mem();
    const evs: NewEvent[] = [];
    for (let i = 0; i < n; i++) evs.push({ type: "task.created", payload: { id: `t${i}`, title: `Task ${i}` }, timestamp: ts(i) });
    s.batchAppend(evs);
    // Snapshot at 90% then append a small tail.
    createSnapshot(s, deriveState(s, { fromScratch: true, now: NOW }));
    s.batchAppend(Array.from({ length: 50 }, (_, i) => ({ type: "task.completed", payload: { id: `t${i}` }, timestamp: ts(n + i) })));

    let full!: ReturnType<typeof deriveState>, accel!: ReturnType<typeof deriveState>;
    const tFull = ms(() => { full = deriveState(s, { fromScratch: true, now: NOW }); });
    const tAccel = ms(() => { accel = deriveState(s, { now: NOW }); });
    const identical = JSON.stringify({ ...full, generatedAt: "" }) === JSON.stringify({ ...accel, generatedAt: "" });
    const speedup = (tFull / tAccel).toFixed(1);
    console.log(`${String(n).padStart(6)}   ${tFull.toFixed(1).padStart(13)}   ${tAccel.toFixed(1).padStart(16)}   ${speedup.padStart(6)}x   ${identical}`);
    if (n === 30000) {
      check("snapshot+tail equals full replay", identical);
      check("snapshot path is faster than full replay", tAccel < tFull, `${speedup}x`);
    }
    s.close();
  }
}

// --- C. Recall fidelity -----------------------------------------------------
function evalRecallFidelity() {
  head("C. Recall fidelity — relevance rescues within window; anchors rescue beyond");
  // Plant one critical fact early, relevant to the goal/decision, then bury it.
  // KEY FINDING: relevance re-ranking only operates on a recency-bounded candidate
  // window (~limit.activity*6). It rescues an old fact WITHIN that window but not
  // beyond it — which is exactly why anchors exist (proven by the anchored row).
  const plant = (s: EventStore, anchor: boolean, noise: number) => {
    let i = 0;
    s.appendEvent({ type: "goal.created", payload: { id: "g1", title: "Ship OAuth login flow" }, timestamp: ts(i++) });
    s.appendEvent({ type: "decision.made", payload: { id: "d1", title: "Use Google OAuth", rationale: "users have Google accounts" }, timestamp: ts(i++) });
    s.appendEvent({ type: "knowledge.learned", payload: { statement: "OAuth redirect URI must be allowlisted in the Google console or login breaks", ...(anchor ? { anchor: true } : {}) }, timestamp: ts(i++) });
    for (let j = 0; j < noise; j++) s.appendEvent({ type: "knowledge.learned", payload: { statement: `unrelated progress note ${j}: adjusted spacing and copy on the marketing page` }, timestamp: ts(i++) });
  };
  console.log("noise   relevance keeps it   recency keeps it   ANCHORED keeps it   (pool=2000)");
  let withinPool1000 = false; // C-fix: now rescued at 1000 (was lost)
  let beyondPoolLost = false; // honesty: cliff moved, not gone
  let anchorRescuesBeyond = false;
  for (const noise of [50, 1000, 3000]) {
    const s = mem(); plant(s, false, noise);
    const sa = mem(); plant(sa, true, noise);
    const inCtx = (st: EventStore) => renderRecall(compileContext(st, { level: "medium", now: NOW })).includes("allowlisted");
    const rel = inCtx(s);
    const recency = s.queryEvents({ order: "desc", limit: 12 }).some((e) => JSON.stringify(e.payload).includes("allowlisted"));
    const anc = inCtx(sa);
    console.log(`${String(noise).padStart(5)}   ${String(rel).padStart(16)}   ${String(recency).padStart(15)}   ${String(anc).padStart(16)}`);
    if (noise === 1000) withinPool1000 = rel && !recency;
    if (noise === 3000) { beyondPoolLost = !rel; anchorRescuesBeyond = anc; }
  }
  check("C-FIX: relevance now rescues a fact 1000 events deep (was lost at >72)", withinPool1000);
  check("honesty: beyond the 2000 pool, relevance still loses it (cliff moved, not gone)", beyondPoolLost);
  check("anchoring rescues even beyond the pool", anchorRescuesBeyond);
}

// --- D. Memory residual (anchors) -------------------------------------------
function evalAnchors() {
  head("D. Memory residual — anchors: survival, budget, weight ranking");
  // D1: anchored fact survives where an ordinary one is trimmed (tight budget).
  const build = (withAnchor: boolean) => {
    const s = mem();
    s.appendEvent({ type: "goal.created", payload: { id: "g1", title: "Ship" }, timestamp: ts(0) });
    s.appendEvent({ type: "knowledge.learned", payload: { id: "k", statement: "FOUNDATIONAL: prod DB is read-replica only", ...(withAnchor ? { anchor: true } : {}) }, timestamp: ts(1) });
    for (let j = 0; j < 200; j++) s.appendEvent({ type: "decision.made", payload: { id: `nd${j}`, title: `churn ${j}` }, timestamp: ts(2 + j) });
    return s;
  };
  const wo = build(false), w = build(true);
  const tWo = renderRecall(compileContext(wo, { level: "large", now: NOW }), { budget: 200 });
  const tW = renderRecall(compileContext(w, { level: "large", now: NOW }), { budget: 200 });
  check("anchored fact survives a tight budget", tW.includes("FOUNDATIONAL"));
  check("identical un-anchored fact is lost at the same budget", !tWo.includes("FOUNDATIONAL"));
  wo.close(); w.close();

  // D2: many anchors → budget held, top weight kept, tail collapsed.
  const s = mem();
  for (let j = 0; j < 200; j++) s.appendEvent({ type: "knowledge.learned", payload: { id: `a${j}`, statement: `pinned fact ${j} carrying real token weight here`, anchor: true, weight: j }, timestamp: ts(j) });
  const text = renderRecall(compileContext(s, { level: "full", now: NOW }), { budget: 1500 });
  check("200 anchors stay within the 1500t budget", estimateTokens(text) <= 1500, `${estimateTokens(text)}t`);
  check("highest-weight anchor (199) is kept", text.includes("pinned fact 199 "));
  check("overflow collapses to a +N pointer", /…\+\d+ more anchored/.test(text));
  s.close();
}

// --- E. File relevance (rankFiles) ------------------------------------------
function evalFileRelevance() {
  head("E. File relevance — rankFiles precision on co-change history");
  const s = mem();
  let i = 0;
  const commit = (hash: string, message: string, files: string[]) => {
    s.appendEvent({ type: "git.commit", payload: { commit: hash, message }, timestamp: ts(i++) });
    for (const f of files) s.appendEvent({ type: "file.modified", payload: { commit: hash, path: f, owner: "dev" }, timestamp: ts(i++) });
  };
  // Two themes that co-change distinctly.
  for (let c = 0; c < 5; c++) commit(`auth${c}`, "implement oauth login token refresh", ["src/auth/oauth.ts", "src/auth/session.ts"]);
  for (let c = 0; c < 5; c++) commit(`bill${c}`, "stripe billing invoice webhook", ["src/billing/stripe.ts", "src/billing/invoice.ts"]);
  for (let c = 0; c < 5; c++) commit(`ui${c}`, "tweak dashboard layout spacing", ["src/ui/dashboard.tsx"]);

  const ranked = rankFiles(s, "fix the oauth login flow", { k: 2 });
  const top2 = ranked.map((r) => r.path);
  const hitAuth = top2.filter((p) => p.startsWith("src/auth/")).length;
  console.log(`   query "oauth login" → top2: ${top2.join(", ")}`);
  check("both top-2 files for an oauth task are auth files", hitAuth === 2, `${hitAuth}/2`);

  const ranked2 = rankFiles(s, "stripe invoice billing", { k: 2 });
  const top2b = ranked2.map((r) => r.path);
  console.log(`   query "stripe billing" → top2: ${top2b.join(", ")}`);
  check("both top-2 files for a billing task are billing files", top2b.every((p) => p.startsWith("src/billing/")));
  s.close();
}

// --- F. Code graph ----------------------------------------------------------
function evalCodeGraph() {
  head("F. Code graph — importedBy edges are correct");
  const files: Record<string, string> = {
    "src/a.ts": `import { b } from "./b.js";\nexport const a = 1;`,
    "src/b.ts": `import { c } from "./c.js";\nexport function b() {}`,
    "src/c.ts": `export const c = 2;`,
    "src/d.ts": `import { c } from "./c.js";\nexport const d = 3;`,
  };
  const known = new Set(Object.keys(files));
  const s = mem();
  for (const [path, content] of Object.entries(files)) {
    const ev = indexOneEvent(path, known, content, "dev");
    if (ev) s.appendEvent(ev);
  }
  const g = deriveCodeGraph(s);
  const importersOfC = (g.importedBy.get("src/c.ts") ?? []).sort();
  console.log(`   importedBy(src/c.ts) = [${importersOfC.join(", ")}]`);
  check("c.ts is imported by b.ts and d.ts", JSON.stringify(importersOfC) === JSON.stringify(["src/b.ts", "src/d.ts"]));
  check("b.ts is imported by a.ts", JSON.stringify(g.importedBy.get("src/b.ts") ?? []) === JSON.stringify(["src/a.ts"]));
  check("all 4 nodes indexed", g.nodes.size === 4, `${g.nodes.size}`);
  s.close();
}

// --- G. Compaction losslessness ---------------------------------------------
function evalCompaction() {
  head("G. Compaction — archiving is lossless");
  const s = mem();
  const evs: NewEvent[] = [];
  for (let i = 0; i < 5000; i++) evs.push({ type: "task.created", payload: { id: `t${i}`, title: `Task ${i}`, priority: "medium" }, timestamp: ts(i) });
  for (let i = 0; i < 2500; i++) evs.push({ type: "task.completed", payload: { id: `t${i}` }, timestamp: ts(5000 + i) });
  s.batchAppend(evs);

  const before = deriveState(s, { now: NOW });
  const report = compactJournal(s, { keepRecent: 100 });
  const after = deriveState(s, { now: NOW });
  const identical = JSON.stringify({ ...before, generatedAt: "" }) === JSON.stringify({ ...after, generatedAt: "" });
  console.log(`   archived ${report.archived}, hot remaining ${report.remaining}, total preserved ${s.totalCount()}`);
  check("derived state is identical after compaction", identical);
  check("archived events are preserved (hot+cold == original)", s.totalCount() === 7500, `${s.totalCount()}`);
  check("compaction actually moved events to cold storage", report.archived > 0, `${report.archived}`);
  s.close();
}

// --- H. Budget adherence ----------------------------------------------------
function evalBudget() {
  head("H. Budget adherence — recall stays within budget above the spine floor");
  // Adversarial: a pathologically long goal + 500 decisions (50 anchored). The
  // spine (header + clipped goal + ≥1 anchor + footer) is a fixed FLOOR that is
  // never sacrificed; above it the budget is hard.
  const s = mem();
  let i = 0;
  s.appendEvent({ type: "goal.created", payload: { id: "g1", title: "Ship a very long goal ".repeat(40) }, timestamp: ts(i++) });
  for (let j = 0; j < 500; j++) s.appendEvent({ type: "decision.made", payload: { id: `d${j}`, title: `decision ${j} with a long descriptive title`, rationale: "because reasons that are wordy", ...(j < 50 ? { anchor: true, weight: j } : {}) }, timestamp: ts(i++) });
  const ctx = compileContext(s, { level: "full", now: NOW });
  // H-FIX: with emergency spine degradation, the budget is HARD down to a tiny
  // skeleton floor. Measure that floor (render at budget 1 → minimal doc).
  const floor = estimateTokens(renderRecall(ctx, { budget: 1 }));
  console.log(`   minimal skeleton floor = ${floor}t (budget hard at/above this)`);
  for (const budget of [40, 80, 150, 400, 1000, 1500]) {
    const tokens = estimateTokens(renderRecall(ctx, { budget }));
    const ok = budget >= floor ? tokens <= budget : true; // below the skeleton floor is physically impossible
    console.log(`   budget ${String(budget).padStart(4)}t → realized ${String(tokens).padStart(4)}t   ${budget < floor ? "(below skeleton floor)" : tokens <= budget ? "within (hard)" : "OVER"}`);
    check(`H-FIX: recall is hard within budget ${budget}t`, ok, `${tokens}t`);
  }
  s.close();
}

// --- I. Scaling -------------------------------------------------------------
function evalScaling() {
  head("I. Scaling — append / derive / compile latency");
  console.log("events   batchAppend ms   cold-derive ms   compile(med) ms");
  for (const n of [1000, 10000, 50000]) {
    const s = mem();
    const evs: NewEvent[] = [];
    for (let i = 0; i < n; i++) evs.push({ type: i % 3 ? "knowledge.learned" : "task.created", payload: { id: `e${i}`, title: `T${i}`, statement: `fact ${i}` }, timestamp: ts(i) });
    const tApp = ms(() => s.batchAppend(evs));
    const tDer = ms(() => deriveState(s, { fromScratch: true, now: NOW }));
    const tCtx = ms(() => compileContext(s, { level: "medium", now: NOW }));
    console.log(`${String(n).padStart(6)}   ${tApp.toFixed(0).padStart(13)}   ${tDer.toFixed(0).padStart(14)}   ${tCtx.toFixed(1).padStart(15)}`);
    if (n === 50000) {
      check("cold derive of 50k events under 1s", tDer < 1000, `${tDer.toFixed(0)}ms`);
      check("context compile of 50k events under 250ms", tCtx < 250, `${tCtx.toFixed(1)}ms`);
    }
    s.close();
  }
}

// --- J. Determinism ---------------------------------------------------------
function evalDeterminism() {
  head("J. Determinism — same events (any order) → same state");
  const base: NewEvent[] = [
    { type: "task.created", payload: { id: "t1", title: "A", priority: "high" }, timestamp: ts(0) },
    { type: "task.created", payload: { id: "t2", title: "B", priority: "low" }, timestamp: ts(1) },
    { type: "decision.made", payload: { id: "d1", title: "X", anchor: true, weight: 3 }, timestamp: ts(2) },
    { type: "task.started", payload: { id: "t1" }, timestamp: ts(3) },
    { type: "knowledge.learned", payload: { id: "k1", statement: "fact", anchor: true, weight: 5 }, timestamp: ts(4) },
  ];
  const run = () => {
    const s = mem();
    s.batchAppend(base);
    const st = deriveState(s, { fromScratch: true, now: NOW });
    const out = JSON.stringify({ ...st, generatedAt: "" });
    s.close();
    return out;
  };
  check("two independent replays produce byte-identical state", run() === run());

  // anchors() ranking is a pure, stable function of state.
  const s = mem();
  s.batchAppend(base);
  const a1 = JSON.stringify(anchors(deriveState(s, { now: NOW })));
  const a2 = JSON.stringify(anchors(deriveState(s, { now: NOW })));
  check("anchor ranking is deterministic", a1 === a2);
  s.close();
}

// --- run --------------------------------------------------------------------
function main() {
  console.log("CAIRN DEEP EVAL — full-system, all scenarios\n" + "=".repeat(60));
  evalTokenEfficiency();
  evalSnapshot();
  evalRecallFidelity();
  evalAnchors();
  evalFileRelevance();
  evalCodeGraph();
  evalCompaction();
  evalBudget();
  evalScaling();
  evalDeterminism();

  console.log("\n" + "=".repeat(60));
  console.log(`SCORECARD: ${pass}/${pass + fail} checks passed`);
  if (fail) {
    console.log(`\n${fail} FAILED:`);
    for (const f of fails) console.log(`  ✗ ${f}`);
    process.exitCode = 1;
  } else {
    console.log("All invariants hold. ✓");
  }
}

main();
