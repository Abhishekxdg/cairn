#!/usr/bin/env node
/**
 * Relevance eval — does "task → relevant files" actually predict the files a
 * task touches, and does it beat the obvious baselines?
 *
 *   npm run build && node scripts/eval-relevance.mjs
 *
 * Method: leave-one-out backtest over commit history. Hold out each commit, rank
 * files from the REST using the held-out commit's message as the query, and
 * check whether the files that commit actually touched land in the top-k.
 * Metrics: Recall@5/@10, MRR, and token-savings (read k files vs the whole repo).
 *
 * Two tracks:
 *   - synthetic : a project with a KNOWN domain→file structure (+ churn files
 *                 that touch every commit) — proves the algorithm at volume and
 *                 isolates what fileIDF buys.
 *   - real      : the project's own journal — proves the wiring end to end.
 *
 * Rankers compared (all deterministic, no LLM):
 *   ajp        BM25 · fileIDF · recency · path-prior   (the system)
 *   no-IDF     same, but WITHOUT the inverse-churn weight (isolates fileIDF)
 *   path-only  query↔path token overlap only            (cold-start floor)
 *   recency    most-recently-touched files, query-blind (lazy baseline)
 *   random     deterministic shuffle                    (chance floor)
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EventStore } from "../dist/core/store.js";
import { buildCorpus, rankFiles, tokenize } from "../dist/engines/relevance.js";
import { deriveCodeGraph } from "../dist/engines/codegraph.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
const pct = (x) => `${(x * 100).toFixed(1)}%`;

// ---------------------------------------------------------------------------
// Synthetic repo with a KNOWN structure, designed to be HARD. Nine domains, each
// owning three OPAQUE module files (src/mod##.ts — the paths carry NO topical
// words, so the path-prior is useless and only commit-history co-occurrence can
// work). Every commit also touches six CHURN files (package.json, CHANGELOG,
// lockfile, barrel index, …) — the trap: they co-occur with every matching
// commit just as strongly as the real core files, so WITHOUT an inverse-churn
// weight they tie with (and, alphabetically, bury) the files you actually want.
// fileIDF is what separates them. This is the term the eval is built to test.
// ---------------------------------------------------------------------------
const NUM_DOMAINS = 9;
const MODS_PER_DOMAIN = 3;
// Invented, domain-unique vocabulary so BM25 routes a query cleanly to its
// domain's commits — and never appears in a file path.
const VOCAB = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india"];
const DOMAINS = Array.from({ length: NUM_DOMAINS }, (_, d) => ({
  vocab: [VOCAB[d], `${VOCAB[d]}x`, `${VOCAB[d]}y`, `${VOCAB[d]}z`],
  core: Array.from({ length: MODS_PER_DOMAIN }, (_, m) => `src/mod${String(d * MODS_PER_DOMAIN + m).padStart(2, "0")}.ts`),
}));
// Six high-churn files. Names chosen to sort BEFORE "src/mod*" so that, on a
// tie, a churn-blind ranker puts them first — exactly the failure we measure.
const CHURN = ["CHANGELOG.md", "CONTRIBUTING.md", "Makefile", "lockfile.lock", "package.json", "src/index.ts"];

// deterministic (no Math.random) so the backtest is reproducible.
function makeRepo(commitsPerDomain) {
  const events = [];
  const truth = []; // { commit, query, coreFiles }
  const base = Date.parse("2025-01-01T00:00:00Z");
  let i = 0;
  for (let rep = 0; rep < commitsPerDomain; rep++) {
    for (let d = 0; d < NUM_DOMAINS; d++) {
      const dom = DOMAINS[d];
      const sha = `c${String(i).padStart(4, "0")}`;
      const ts = new Date(base + i * 3600_000).toISOString(); // 1h apart
      // intent: 2-3 of the domain's invented words — the words an agent types.
      const w = [dom.vocab[rep % dom.vocab.length], dom.vocab[(rep + 1) % dom.vocab.length], dom.vocab[(rep + 2) % dom.vocab.length]];
      const message = `implement ${w[0]} ${w[1]} handling and ${w[2]} path`;
      const files = [...dom.core, ...CHURN];
      events.push({ type: "git.commit", timestamp: ts, actor: "dev", payload: { commit: sha, message } });
      for (const path of files) {
        events.push({ type: "file.modified", timestamp: ts, actor: "dev", payload: { commit: sha, path, owner: "dev" } });
      }
      truth.push({ commit: sha, query: message, coreFiles: dom.core });
      i++;
    }
  }
  return { events, truth };
}

// --- rankers (each: (corpus, query, now) -> ordered file paths) -------------
function rankAjp(corpus, query, now) {
  return rankFiles(null, query, { corpus, now, k: 1000 }).map((f) => f.path);
}
function rankNoIdf(corpus, query, now) {
  // fileIDF removed by flattening it: clone corpus where every file is unique to
  // its commit can't be done cheaply, so re-implement the aggregate sans IDF.
  return aggregate(corpus, query, now, { idf: false, recency: true, alpha: 0.25 });
}
function rankPathOnly(corpus, query, now) {
  return aggregate(corpus, query, now, { idf: true, recency: true, alpha: 1.0 });
}
function rankRecency(corpus, _query, _now) {
  const last = new Map();
  for (const d of corpus) for (const f of d.files) {
    const t = Date.parse(d.timestamp);
    if (!last.has(f.path) || t > last.get(f.path)) last.set(f.path, t);
  }
  return [...last.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
}
function rankRandom(corpus, query, _now) {
  // deterministic shuffle: hash(path + query) order.
  const files = new Set();
  for (const d of corpus) for (const f of d.files) files.add(f.path);
  const h = (s) => { let x = 2166136261; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } return x >>> 0; };
  return [...files].sort((a, b) => h(a + query) - h(b + query));
}

// A reference aggregator used to build the ablations (no-IDF, path-only) on the
// same math as the engine, toggling one term at a time.
function aggregate(corpus, query, now, { idf, recency, alpha }) {
  const q = new Set(tokenize(query));
  const qTokens = tokenize(query);
  const N = corpus.length;
  const df = new Map();
  for (const d of corpus) for (const f of d.files) df.set(f.path, (df.get(f.path) ?? 0) + 1);
  const fileIdf = (p) => (idf ? Math.log(1 + N / (df.get(p) ?? 1)) : 1);
  // bm25-ish: idf(term)·tf saturation. Reuse a light scorer.
  const dl = corpus.map((d) => d.tokens.length);
  const avgdl = N ? dl.reduce((a, b) => a + b, 0) / N : 1;
  const dft = new Map();
  for (const d of corpus) for (const t of new Set(d.tokens)) dft.set(t, (dft.get(t) ?? 0) + 1);
  const tidf = (t) => Math.log(1 + (N - (dft.get(t) ?? 0) + 0.5) / ((dft.get(t) ?? 0) + 0.5));
  const k1 = 1.5, b = 0.75;
  const acc = new Map();
  const allFiles = new Set();
  corpus.forEach((d, i) => {
    for (const f of d.files) allFiles.add(f.path);
    const tf = new Map();
    for (const t of d.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    let rel = 0;
    for (const t of new Set(qTokens)) {
      const f = tf.get(t); if (!f) continue;
      rel += tidf(t) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (dl[i] / avgdl)));
    }
    if (rel <= 0) return;
    const age = Math.max(0, (now - Date.parse(d.timestamp)) / 86400000);
    const rec = recency ? Math.exp(-age / 60) : 1;
    for (const f of d.files) acc.set(f.path, (acc.get(f.path) ?? 0) + rel * rec * fileIdf(f.path));
  });
  const maxCo = Math.max(1e-9, ...acc.values());
  const pathScore = (p) => { const pt = tokenize(p); let h = 0; for (const t of pt) if (q.has(t)) h++; return pt.length ? h / Math.sqrt(pt.length) : 0; };
  const pathRaw = new Map(); let maxPath = 1e-9;
  for (const p of allFiles) { const ps = pathScore(p); if (ps > 0) { pathRaw.set(p, ps); maxPath = Math.max(maxPath, ps); } }
  const score = new Map();
  for (const [p, co] of acc) score.set(p, (score.get(p) ?? 0) + (1 - alpha) * (co / maxCo));
  for (const [p, ps] of pathRaw) score.set(p, (score.get(p) ?? 0) + alpha * (ps / maxPath));
  return [...score.entries()].filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([p]) => p);
}

// --- metrics ----------------------------------------------------------------
function recallAt(ranked, gold, k) {
  const top = new Set(ranked.slice(0, k));
  let hit = 0; for (const g of gold) if (top.has(g)) hit++;
  return hit / gold.length;
}
function mrr(ranked, gold) {
  for (let i = 0; i < ranked.length; i++) if (gold.includes(ranked[i])) return 1 / (i + 1);
  return 0;
}

function backtest(corpusAll, truth, now) {
  const rankers = {
    ajp: rankAjp, "no-IDF": rankNoIdf, "path-only": rankPathOnly, recency: rankRecency, random: rankRandom,
  };
  const agg = {};
  for (const name of Object.keys(rankers)) agg[name] = { r5: 0, r10: 0, mrr: 0, n: 0 };
  for (const t of truth) {
    const heldout = corpusAll.filter((d) => d.commit !== t.commit);
    for (const [name, fn] of Object.entries(rankers)) {
      const ranked = fn(heldout, t.query, now);
      agg[name].r5 += recallAt(ranked, t.coreFiles, 5);
      agg[name].r10 += recallAt(ranked, t.coreFiles, 10);
      agg[name].mrr += mrr(ranked, t.coreFiles);
      agg[name].n++;
    }
  }
  for (const a of Object.values(agg)) { a.r5 /= a.n; a.r10 /= a.n; a.mrr /= a.n; }
  return agg;
}

// ===========================================================================
console.log("AJP relevance eval — task → relevant files (leave-one-out backtest)\n");

// --- Synthetic track --------------------------------------------------------
{
  const PER_DOMAIN = 18;
  const COMMITS = PER_DOMAIN * NUM_DOMAINS;
  const { events, truth } = makeRepo(PER_DOMAIN);
  const dir = mkdtempSync(join(tmpdir(), "ajp-rel-"));
  const store = new EventStore(join(dir, "j.db"), { projectId: "rel" });
  store.batchAppend(events);
  const corpusAll = buildCorpus(store);
  const now = Math.max(...corpusAll.map((d) => Date.parse(d.timestamp)));
  const totalFiles = new Set(corpusAll.flatMap((d) => d.files.map((f) => f.path))).size;

  console.log(`SYNTHETIC — ${COMMITS} commits, ${totalFiles} distinct files (opaque paths), ${NUM_DOMAINS} domains + ${CHURN.length} churn files\n`);
  console.log(`  ${pad("ranker", 12)}${padL("Recall@5", 10)}${padL("Recall@10", 11)}${padL("MRR", 8)}`);
  console.log("  " + "-".repeat(41));
  const agg = backtest(corpusAll, truth, now);
  for (const [name, a] of Object.entries(agg)) {
    console.log(`  ${pad(name, 12)}${padL(pct(a.r5), 10)}${padL(pct(a.r10), 11)}${padL(a.mrr.toFixed(3), 8)}`);
  }
  const aj = agg.ajp, noidf = agg["no-IDF"];
  console.log(`\n  → fileIDF lifts Recall@5 from ${pct(noidf.r5)} (no-IDF) to ${pct(aj.r5)} — it demotes the`);
  console.log(`    churn files (package.json/CHANGELOG/index) that co-occur with every commit.`);
  console.log(`  → token savings: read top-5 of ${totalFiles} files ≈ ${pct(1 - 5 / totalFiles)} fewer files than the whole repo.`);
  store.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- Cold-start track -------------------------------------------------------
// The case co-occurrence CANNOT handle: a brand-new repo with ZERO git history.
// Only the static index (imports + exported symbols) has anything to say. Each
// domain has two "core" files whose exported symbols carry the domain word, plus
// a helper file with an OPAQUE symbol that the core files import — so proximity
// is the only way to surface it. Paths are opaque throughout, so path-grep is a
// floor of ~0. We emit ONLY code.indexed events (no commits) and rank with the
// history corpus empty.
{
  const VOCAB2 = ["payment", "auth", "search", "billing", "notify", "upload", "report", "session"];
  const events = [];
  const truth = []; // { query, coreFiles, helper }
  VOCAB2.forEach((word, d) => {
    const a = `src/m${d}a.ts`, b = `src/m${d}b.ts`, h = `src/m${d}h.ts`;
    // core files: symbols embed the domain word; they import the opaque helper.
    events.push({ type: "code.indexed", payload: { path: a, lang: "js-ts", imports: [h], exports: [`${word}Service`, `${word}Create`] } });
    events.push({ type: "code.indexed", payload: { path: b, lang: "js-ts", imports: [h], exports: [`${word}Handler`, `${word}Update`] } });
    // helper: opaque symbol, no domain word — reachable ONLY via import proximity.
    events.push({ type: "code.indexed", payload: { path: h, lang: "js-ts", imports: [], exports: [`util${d}`] } });
    // query uses ONLY the discriminating domain word — the shared "Service"/
    // "Handler" suffixes would otherwise match every domain's files.
    truth.push({ query: `${word} feature work`, coreFiles: [a, b], helper: h });
  });

  const dir = mkdtempSync(join(tmpdir(), "ajp-cold-"));
  const store = new EventStore(join(dir, "j.db"), { projectId: "cold" });
  store.batchAppend(events);
  const graph = deriveCodeGraph(store);
  const totalFiles = graph.nodes.size;

  console.log(`\nCOLD-START — ${totalFiles} files, ZERO git history, opaque paths (index-only)\n`);
  console.log(`  ${pad("ranker", 14)}${padL("core R@3", 10)}${padL("helper@5", 10)}${padL("MRR", 8)}`);
  console.log("  " + "-".repeat(42));
  const variants = {
    // full fusion, but corpus (history) is empty → only sym + proximity + path fire.
    "ajp(index)": (q) => rankFiles(null, q, { corpus: [], graph, now: 0, k: 1000 }).map((f) => f.path),
    // path-only: the cold-start floor people actually ship.
    "path-only": (q) => rankFiles(null, q, { corpus: [], graph, now: 0, k: 1000, weights: { co: 0, sym: 0, path: 1, proximity: 0 } }).map((f) => f.path),
  };
  for (const [name, fn] of Object.entries(variants)) {
    let r3 = 0, hh = 0, mr = 0;
    for (const t of truth) {
      const ranked = fn(t.query);
      r3 += recallAt(ranked, t.coreFiles, 3);
      hh += ranked.slice(0, 5).includes(t.helper) ? 1 : 0;
      mr += mrr(ranked, t.coreFiles);
    }
    console.log(`  ${pad(name, 14)}${padL(pct(r3 / truth.length), 10)}${padL(pct(hh / truth.length), 10)}${padL((mr / truth.length).toFixed(3), 8)}`);
  }
  console.log(`\n  → on a history-less repo the index gives real recall where path-grep is ~0;`);
  console.log(`    'helper@5' = an opaque file with NO matching symbol, surfaced purely by import proximity.`);
  store.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- Real track -------------------------------------------------------------
{
  const root = join(HERE, "..", "..");
  const dbPath = join(root, ".agent", "journal.db");
  console.log("\nREAL — the project's own journal");
  if (!existsSync(dbPath)) {
    console.log("  (no .agent/journal.db — run `ajp sync` first)");
  } else {
    const store = new EventStore(dbPath, { readonly: true });
    const corpus = buildCorpus(store);
    const now = Math.max(0, ...corpus.map((d) => Date.parse(d.timestamp)));
    console.log(`  ${corpus.length} commits with files in the journal (small corpus — qualitative).\n`);
    for (const q of ["intent extraction from commits", "context compiler minimal tokens", "sqlite store concurrency"]) {
      const top = rankFiles(store, q, { corpus, now, k: 3 });
      console.log(`  "${q}"`);
      for (const f of top) console.log(`     ${f.score.toFixed(3)}  ${f.path}`);
      console.log("");
    }
    store.close();
  }
}

console.log("done.");
