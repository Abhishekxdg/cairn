import type { EventStore } from "../core/store.js";
import type { CorpusDoc, FileScore, TaskContext, CodeGraph } from "../core/types.js";
import { compileContext, type ContextLevel } from "./context.js";
import { deriveKnowledge } from "./memory.js";
import { deriveCodeGraph } from "./codegraph.js";

/**
 * Task → Relevant Files → Minimal Context.
 *
 * The breakthrough layer: given a task description, return the SMALLEST set of
 * files an agent must read — instead of the whole repo. This is where the real
 * token savings live.
 *
 * The data already exists in the journal: every commit emits a `git.commit`
 * event (its message = *intent*) plus one `file.*` event per touched file, all
 * joined by `payload.commit`. That is a ready-made (intent → files) corpus. We
 * mine it with a deterministic ranker — BM25 over commit intents, aggregated to
 * files with an inverse-churn weight + recency decay + a path-lexical prior. No
 * embeddings, no LLM, no new dependencies. Embeddings stay a later (Layer 10)
 * upgrade; co-occurrence is the cheap, backtestable v1.
 */

// --- tokenizer ---------------------------------------------------------------

/** Conventional-commit prefixes carry no topical signal — drop them. */
const CC_PREFIX = new Set([
  "feat", "fix", "chore", "refactor", "docs", "test", "tests", "style",
  "perf", "build", "ci", "revert", "wip", "merge",
]);

/** Tiny stoplist: English filler + code-noise words that match everything. */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "for", "with",
  "at", "by", "from", "into", "is", "are", "be", "as", "it", "this", "that",
  "add", "added", "adds", "update", "updated", "updates", "use", "using", "via",
  "make", "made", "set", "get", "new", "now", "so", "out", "up", "we", "i",
]);

/**
 * Lowercase; split on non-alphanumerics; split camelCase + snake_case; drop
 * conventional-commit prefixes, stopwords, and 1-char tokens; light suffix trim.
 * Shared by query, commit intents, and file paths so they score on equal terms.
 */
export function tokenize(s: string): string[] {
  const out: string[] = [];
  // camelCase → camel Case, then split on every non-alphanumeric run.
  const split = s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/);
  for (const raw of split) {
    const t = raw.toLowerCase();
    if (t.length < 2) continue;
    if (CC_PREFIX.has(t) || STOPWORDS.has(t)) continue;
    out.push(stem(t));
  }
  return out;
}

/** Light, conservative suffix trim — enough to fold plurals/gerunds, no Porter. */
function stem(t: string): string {
  if (t.length > 4 && t.endsWith("ing")) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith("ed")) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

// --- corpus ------------------------------------------------------------------

const FILE_TYPES = new Set(["file.created", "file.modified", "file.deleted"]);

interface CommitBuild {
  commit: string;
  intent: string[];
  files: Map<string, { owner: string; lastTouched: string; deleted: boolean }>;
  timestamp: string;
}

/**
 * Fold the journal into one doc per commit: the commit message (+ any task title
 * tagged with that commit) as intent text, and the set of files it touched. A
 * file whose latest event is `file.deleted` is dropped — no point recommending a
 * file that no longer exists. Pure read over `EventStore` → single source of
 * truth, no separate git read.
 */
export function buildCorpus(store: EventStore): CorpusDoc[] {
  const byCommit = new Map<string, CommitBuild>();
  // Global latest status per path (events stream in seq order → last write wins):
  // a file deleted in a *later* commit must vanish from *earlier* docs too.
  const liveStatus = new Map<string, boolean>();
  const ensure = (commit: string, ts: string): CommitBuild => {
    let b = byCommit.get(commit);
    if (!b) {
      b = { commit, intent: [], files: new Map(), timestamp: ts };
      byCommit.set(commit, b);
    }
    return b;
  };

  for (const ev of store.streamEvents({ includeArchive: true })) {
    const p = ev.payload;
    if (ev.type === "git.commit") {
      const commit = typeof p["commit"] === "string" ? p["commit"] : null;
      if (!commit) continue;
      const b = ensure(commit, ev.timestamp);
      b.timestamp = ev.timestamp;
      if (typeof p["message"] === "string") b.intent.push(p["message"]);
    } else if (FILE_TYPES.has(ev.type)) {
      const commit = typeof p["commit"] === "string" ? p["commit"] : null;
      const path = typeof p["path"] === "string" ? p["path"] : null;
      if (!commit || !path) continue;
      const b = ensure(commit, ev.timestamp);
      b.files.set(path, {
        owner: typeof p["owner"] === "string" ? p["owner"] : ev.actor,
        lastTouched: ev.timestamp,
        deleted: ev.type === "file.deleted",
      });
      liveStatus.set(path, ev.type !== "file.deleted");
    } else if (ev.type === "task.created" || ev.type === "task.started") {
      // A task tagged with a commit lends its title as extra intent text.
      const commit = typeof p["gitCommit"] === "string" ? p["gitCommit"] : null;
      if (commit && typeof p["title"] === "string") ensure(commit, ev.timestamp).intent.push(p["title"]);
    }
  }

  const docs: CorpusDoc[] = [];
  for (const b of byCommit.values()) {
    const files = [...b.files.entries()]
      .filter(([path, m]) => !m.deleted && liveStatus.get(path) !== false)
      .map(([path, m]) => ({ path, owner: m.owner, lastTouched: m.lastTouched }));
    if (!files.length) continue; // no readable files → not useful for ranking
    docs.push({
      commit: b.commit,
      intent: b.intent.join(" "),
      tokens: tokenize(b.intent.join(" ")),
      files,
      timestamp: b.timestamp,
    });
  }
  return docs;
}

// --- BM25 --------------------------------------------------------------------

const K1 = 1.5;
const B = 0.75;

interface Bm25 {
  score(queryTokens: string[], docIdx: number): number;
}

function buildBm25(docs: CorpusDoc[]): Bm25 {
  const N = docs.length;
  const dl = docs.map((d) => d.tokens.length);
  const avgdl = N ? dl.reduce((a, b) => a + b, 0) / N : 0;
  // term frequency per doc, and document frequency per term.
  const tf: Array<Map<string, number>> = docs.map((d) => {
    const m = new Map<string, number>();
    for (const t of d.tokens) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
  });
  const df = new Map<string, number>();
  for (const m of tf) for (const t of m.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (t: string): number => {
    const n = df.get(t) ?? 0;
    return Math.log(1 + (N - n + 0.5) / (n + 0.5));
  };
  return {
    score(queryTokens, i) {
      if (!N || avgdl === 0) return 0;
      const docTf = tf[i]!;
      const len = dl[i]!;
      let s = 0;
      for (const t of new Set(queryTokens)) {
        const f = docTf.get(t);
        if (!f) continue;
        const num = f * (K1 + 1);
        const den = f + K1 * (1 - B + B * (len / avgdl));
        s += idf(t) * (num / den);
      }
      return s;
    },
  };
}

// --- ranker ------------------------------------------------------------------

export interface RankOptions {
  /** How many files to return. Default 10. */
  k?: number;
  /** Recency half-life in days. Default 60. */
  halflifeDays?: number;
  /** Component weights (auto-normalized per file → cold/warm self-balances). */
  weights?: { co?: number; sym?: number; path?: number; proximity?: number };
  /** Reference "now" (ms) for recency. Default = newest commit (deterministic). */
  now?: number;
  /** Pre-built corpus (for backtests that hold out docs). */
  corpus?: CorpusDoc[];
  /** Pre-built code graph (for backtests / cold-start with no history). */
  graph?: CodeGraph;
  /** Out-param: rankFiles fills this with corpus/graph sizes for diagnostics. */
  diag?: { corpusSize: number; graphNodes: number };
}

const DAY_MS = 86_400_000;
const W_DEFAULT = { co: 0.5, sym: 0.3, path: 0.2, proximity: 0.3 };

/**
 * Rank files by relevance to a free-text task description, fusing the BEHAVIORAL
 * signal (git history) with the STATIC signal (code graph) so it works on a
 * brand-new repo as well as a mature one:
 *
 *   base(file) = w_co·coOccur + w_sym·symbolMatch + w_path·pathMatch
 *   score(file) = base + w_prox·maxNeighborBase / √(1+degree)
 *
 *   coOccur     = Σ_commits touching it [ bm25(q,commit)·recency·fileIDF ]   (history)
 *   symbolMatch = query ∩ tokenized(exported symbols)                        (index)
 *   proximity   = a file imported by / importing a strong match              (graph)
 *
 * Each component is normalized to [0,1] independently, so a component that is
 * all-zero (e.g. coOccur on a history-less repo) simply drops out and the others
 * decide — no cold/warm branching. fileIDF still demotes high-churn files;
 * proximity is damped by node degree so a barrel `index.ts` (huge fan-in) can't
 * float up just by importing a hot file.
 */
export function rankFiles(store: EventStore, query: string, opts: RankOptions = {}): FileScore[] {
  const k = opts.k ?? 10;
  const halflife = opts.halflifeDays ?? 60;
  const W = { ...W_DEFAULT, ...(opts.weights ?? {}) };
  // `store` may be null in backtests that supply corpus/graph directly.
  const corpus = opts.corpus ?? (store ? buildCorpus(store) : []);
  const graph = opts.graph ?? (store ? deriveCodeGraph(store) : ({ nodes: new Map(), importedBy: new Map() } as CodeGraph));
  if (opts.diag) { opts.diag.corpusSize = corpus.length; opts.diag.graphNodes = graph.nodes.size; }
  const qTokens = tokenize(query);
  if (!qTokens.length) return [];
  if (!corpus.length && graph.nodes.size === 0) return [];
  const qset = new Set(qTokens);

  const corpusMax = corpus.reduce((max, d) => Math.max(max, Date.parse(d.timestamp) || 0), 0);
  const now = opts.now ?? (corpusMax || Date.now());

  // Universe of files = everything history OR the index knows about.
  interface Meta { owner: string; lastTouched: string }
  const meta = new Map<string, Meta>();
  for (const d of corpus) for (const f of d.files) {
    const prev = meta.get(f.path);
    if (!prev || f.lastTouched > prev.lastTouched) meta.set(f.path, { owner: f.owner, lastTouched: f.lastTouched });
  }
  for (const path of graph.nodes.keys()) if (!meta.has(path)) meta.set(path, { owner: "", lastTouched: "" });

  const overlap = (text: string): number => {
    const t = tokenize(text);
    if (!t.length) return 0;
    let hits = 0;
    for (const x of t) if (qset.has(x)) hits++;
    return hits / Math.sqrt(t.length); // length-normalized overlap
  };

  // --- co-occurrence (history) ---
  const df = new Map<string, number>();
  for (const d of corpus) for (const f of d.files) df.set(f.path, (df.get(f.path) ?? 0) + 1);
  const N = corpus.length;
  const fileIdf = (path: string): number => Math.log(1 + N / (df.get(path) ?? 1));
  const bm25 = buildBm25(corpus);
  const co = new Map<string, number>();
  const whyCommit = new Map<string, { score: number; msg: string }>();
  corpus.forEach((doc, i) => {
    const rel = bm25.score(qTokens, i);
    if (rel <= 0) return;
    const ageDays = Math.max(0, (now - (Date.parse(doc.timestamp) || now)) / DAY_MS);
    const recency = Math.exp(-ageDays / halflife);
    for (const f of doc.files) {
      co.set(f.path, (co.get(f.path) ?? 0) + rel * recency * fileIdf(f.path));
      const w = whyCommit.get(f.path);
      if (!w || rel > w.score) whyCommit.set(f.path, { score: rel, msg: doc.intent });
    }
  });

  // --- symbol match (static index) ---
  const sym = new Map<string, number>();
  const whySym = new Map<string, string>();
  for (const [path, node] of graph.nodes) {
    const s = overlap(node.exports.join(" "));
    if (s <= 0) continue;
    sym.set(path, s);
    const hit = node.exports.find((e) => tokenize(e).some((t) => qset.has(t)));
    if (hit) whySym.set(path, `exports ${hit}`);
  }

  // --- path prior (all files) ---
  const pathRaw = new Map<string, number>();
  for (const path of meta.keys()) { const ps = overlap(path); if (ps > 0) pathRaw.set(path, ps); }

  // Normalize each component independently → all-zero components drop out.
  const norm = (m: Map<string, number>) => {
    const mx = Math.max(1e-9, ...m.values());
    return (p: string): number => (m.get(p) ?? 0) / mx;
  };
  const coN = norm(co), symN = norm(sym), pathN = norm(pathRaw);

  const base = new Map<string, number>();
  for (const path of meta.keys()) {
    const b = W.co * coN(path) + W.sym * symN(path) + W.path * pathN(path);
    if (b > 0) base.set(path, b);
  }

  // --- import proximity (graph): a file next to a strong match gets a boost,
  //     damped by its own degree so hubs don't free-ride. ---
  const neighbors = (p: string): Set<string> => {
    const n = new Set<string>();
    const node = graph.nodes.get(p);
    if (node) for (const dep of node.imports) n.add(dep);
    for (const r of graph.importedBy.get(p) ?? []) n.add(r);
    return n;
  };
  const degree = (p: string): number => {
    const node = graph.nodes.get(p);
    return (node?.imports.length ?? 0) + (graph.importedBy.get(p)?.length ?? 0);
  };

  const result: FileScore[] = [];
  const consider = new Set<string>([...base.keys(), ...graph.nodes.keys()]);
  for (const path of consider) {
    let bestNb = 0, bestNbPath = "";
    for (const nb of neighbors(path)) {
      const bn = base.get(nb) ?? 0;
      if (bn > bestNb) { bestNb = bn; bestNbPath = nb; }
    }
    const score = (base.get(path) ?? 0) + W.proximity * bestNb / Math.sqrt(1 + degree(path));
    if (score <= 0) continue;
    let why = whyCommit.get(path)?.msg ?? whySym.get(path) ?? "";
    if (!why) why = bestNbPath ? `imports ${bestNbPath}` : pathRaw.has(path) ? "path match" : "";
    const m = meta.get(path) ?? { owner: "", lastTouched: "" };
    result.push({ path, score, why, owner: m.owner, lastTouched: m.lastTouched });
  }

  return result
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, k);
}

// --- task context (the Context-Compiler MVP) --------------------------------

export interface TaskContextOptions extends RankOptions {
  level?: ContextLevel;
}

/**
 * Compile the minimum useful context for a SPECIFIC task: the standard project
 * context (goal/tasks/decisions) plus the ranked relevant files and the
 * decisions/knowledge whose text overlaps the task. The bridge between project
 * memory and code understanding — the smallest block an agent needs to act.
 */
export function compileTaskContext(store: EventStore, query: string, opts: TaskContextOptions = {}): TaskContext {
  const base = compileContext(store, { level: opts.level ?? "medium" });
  const relevantFiles = rankFiles(store, query, opts);
  const qset = new Set(tokenize(query));
  const overlaps = (text: string): boolean => {
    for (const t of tokenize(text)) if (qset.has(t)) return true;
    return false;
  };
  // Decisions/knowledge whose text overlaps the task — pulled from the already
  // compiled (active-only) context and the derived knowledge projection.
  const decisions = base.activeDecisions.filter((d) => overlaps(`${d.title} ${d.rationale}`));
  const knowledge = deriveKnowledge(store)
    .filter((k) => overlaps(k.statement))
    .map((k) => ({ statement: k.statement, source: k.source }));

  return {
    task: query,
    ...base,
    relevantFiles,
    relatedDecisions: decisions,
    relatedKnowledge: knowledge,
  };
}
