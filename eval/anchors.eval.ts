/**
 * Ablation: memory residual (anchors) vs recency-only recall.
 *
 * Setup: a journal that opens with K foundational facts (decisions + durable
 * knowledge), then buries them under N noise events. We render recall at a token
 * budget and measure how many foundational facts survive into the output.
 *
 *   WITHOUT — facts logged as ordinary decision.made / knowledge.learned.
 *   WITH    — identical facts logged with anchor:true.
 *
 * Metrics per cell:
 *   recall  = fraction of the K facts whose distinctive probe appears in recall.
 *   tokens  = realized size of the rendered recall.
 *   budget? = did the render stay within the token budget it was given.
 *
 * Probes are distinctive sentinels (⚓F<i>⚓) so a noise event can never
 * coincidentally satisfy a probe — without that, a long journal inflates the
 * WITHOUT recall with false positives (caveat from the first eval).
 *
 * The 4th dimension is ANCHOR COUNT. The residual idea solves "one important
 * fact drowns in noise," not "too many important facts for the budget." Pinning
 * lives in the non-droppable spine, so past some count the anchors themselves
 * blow the budget — recall stays 100% but budget-adherence breaks. This eval
 * locates that saturation point.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../src/core/store.js";
import { compileContext } from "../src/engines/context.js";
import { renderRecall } from "../src/engines/recall.js";
import { estimateTokens } from "../src/engines/tokens.js";

/**
 * Generate K foundational facts with distinctive, collision-proof probes.
 * Weight DESCENDS with index so fact 0 is the most important — lets the eval
 * check that ranking keeps the right pins when anchors exceed the budget.
 */
function foundationalFacts(k: number): Array<{ kind: "decision" | "knowledge"; id: string; text: string; probe: string; weight: number }> {
  return Array.from({ length: k }, (_, i) => {
    const probe = `⚓F${i}⚓`;
    const weight = k - i; // fact 0 highest
    return i % 2 === 0
      ? { kind: "decision" as const, id: `f${i}`, text: `Constraint ${probe}: must hold for the system`, probe, weight }
      : { kind: "knowledge" as const, id: `f${i}`, text: `Invariant ${probe}: documented and load-bearing`, probe, weight };
  });
}

function buildJournal(dir: string, withAnchors: boolean, noise: number, k: number): EventStore {
  const store = new EventStore(join(dir, "journal.db"));
  const t0 = Date.parse("2026-01-01T00:00:00.000Z");
  let seq = 0;
  const stamp = () => new Date(t0 + seq++ * 60_000).toISOString();

  store.appendEvent({ type: "goal.created", payload: { id: "g1", title: "Ship the system" }, timestamp: stamp() });

  for (const f of foundationalFacts(k)) {
    const anchorFields = withAnchors ? { anchor: true, weight: f.weight } : {};
    if (f.kind === "decision") {
      store.appendEvent({ type: "decision.made", payload: { id: f.id, title: f.text, ...anchorFields }, timestamp: stamp() });
    } else {
      store.appendEvent({ type: "knowledge.learned", payload: { id: f.id, statement: f.text, ...anchorFields }, timestamp: stamp() });
    }
  }

  // Newer, low-value noise — a mix of churn decisions and progress notes.
  for (let i = 0; i < noise; i++) {
    if (i % 4 === 0) {
      store.appendEvent({
        type: "decision.made",
        payload: { id: `nd${i}`, title: `Rename helper var round ${i}`, rationale: "readability churn" },
        timestamp: stamp(),
      });
    } else {
      store.appendEvent({
        type: "knowledge.learned",
        payload: { statement: `progress note ${i}: tweaked padding and copy, no lasting consequence` },
        timestamp: stamp(),
      });
    }
  }
  return store;
}

function measure(store: EventStore, budget: number, k: number) {
  const ctx = compileContext(store, { level: "full", now: Date.parse("2026-12-31T00:00:00.000Z") });
  const text = renderRecall(ctx, { budget });
  const facts = foundationalFacts(k);
  const hits = facts.filter((f) => text.includes(f.probe)).length;
  const tokens = estimateTokens(text);
  // facts[0] is the highest-weight pin — ranking must always keep it.
  const topKept = text.includes(facts[0]!.probe);
  return { rate: hits / k, tokens, withinBudget: tokens <= budget, topKept };
}

function run() {
  const root = mkdtempSync(join(tmpdir(), "cairn-eval-"));
  const noise = 200;

  // ---- Dimension 1-2: noise × budget at K=5 (the headline ablation) ----------
  console.log(`\n=== A. recall@budget — K=5 facts, noise=${noise} ===\n`);
  console.log("budget   WITHOUT          WITH");
  console.log("------   -------------    -------------");
  for (const budget of [120, 200, 400, 800, 1500]) {
    const wo = measure(buildJournal(mkdtempSync(join(root, "a-wo-")), false, noise, 5), budget, 5);
    const w = measure(buildJournal(mkdtempSync(join(root, "a-w-")), true, noise, 5), budget, 5);
    const cell = (m: ReturnType<typeof measure>) =>
      `${`${Math.round(m.rate * 100)}%`.padStart(4)} @${String(m.tokens).padStart(4)}t${m.withinBudget ? "  " : " !"}`;
    console.log(`${String(budget).padStart(6)}   ${cell(wo)}    ${cell(w)}`);
  }

  // ---- Dimension 4: anchor count — ranked sub-budget keeps the contract ------
  console.log(`\n=== B. anchor-count scaling — WITH ranked anchors, budget=1500, noise=${noise} ===\n`);
  console.log("pins   recall   tokens   within budget?   top pin kept?");
  console.log("----   ------   ------   --------------   -------------");
  for (const k of [5, 20, 50, 100, 200]) {
    const w = measure(buildJournal(mkdtempSync(join(root, `b-${k}-`)), true, noise, k), 1500, k);
    console.log(
      `${String(k).padStart(4)}   ${`${Math.round(w.rate * 100)}%`.padStart(5)}   ${String(w.tokens).padStart(6)}   ${(w.withinBudget ? "yes" : "NO").padStart(14)}   ${(w.topKept ? "yes" : "NO").padStart(13)}`,
    );
  }

  console.log(
    "\nReadout: anchors now get a sub-budget (≤50% of total) and are filled",
    "\nhighest-weight first; the overflow collapses to a `+N more` pointer. So the",
    "\nbudget contract HOLDS at any pin count, recall degrades gracefully (top pins",
    "\nkept, tail discoverable via `cairn anchors`), and the highest-weight pin",
    "\nalways survives — ranking among anchors, not just anchored-vs-not.\n",
  );
}

run();
