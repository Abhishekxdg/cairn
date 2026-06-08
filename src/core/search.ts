import type { SearchType, SearchDoc, SearchHit } from "./types.js";
import { readTasks } from "./tasks.js";
import { readDecisions } from "./decisions.js";
import { readGoals } from "./goals.js";

/**
 * Keyword search over the project brain — pure BM25, no embeddings, no models.
 *
 * Stated's thesis is "no AI, no network": this gives agents a fast way to pull
 * just the relevant tasks/decisions/goals out of `.stated/` instead of loading
 * the whole handoff. The ranking is deterministic and dependency-free, so the
 * same query always yields the same order and results stay diffable in tests.
 */

// Okapi BM25 tuning constants. k1 controls term-frequency saturation; b
// controls length normalization. These are the standard defaults.
const K1 = 1.5;
const B = 0.75;

/**
 * A short, conservative English stopword list. Dropping these keeps high-IDF
 * content words in control of ranking without needing a stemmer.
 */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "if", "in",
  "into", "is", "it", "no", "not", "of", "on", "or", "such", "that", "the",
  "their", "then", "there", "these", "they", "this", "to", "was", "will",
  "with", "we", "our", "you", "your",
]);

/** Lowercase and split text into alphanumeric tokens. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/** Tokenize and drop stopwords + single characters (used for queries). */
function queryTerms(text: string): string[] {
  return tokenize(text).filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Build the searchable corpus from the canonical `.stated/` files. Each task,
 * decision and goal becomes one document.
 */
export function buildCorpus(root: string): SearchDoc[] {
  const docs: SearchDoc[] = [];

  for (const t of readTasks(root)) {
    docs.push({
      type: "task",
      id: t.id,
      title: t.title,
      text: `${t.title} ${t.description}`.trim(),
      meta: { status: t.status, owner: t.owner, priority: t.priority, ...(t.runId ? { runId: t.runId } : {}) },
    });
  }

  for (const d of readDecisions(root)) {
    docs.push({
      type: "decision",
      id: d.id,
      title: d.decision,
      text: `${d.decision} ${d.reason}`.trim(),
      meta: { date: d.date, madeBy: d.madeBy, ...(d.runId ? { runId: d.runId } : {}) },
    });
  }

  const goals = readGoals(root);
  goals.active.forEach((g, i) => {
    docs.push({ type: "goal", id: `goal-active-${i + 1}`, title: g, text: g, meta: { state: "active" } });
  });
  goals.completed.forEach((g, i) => {
    docs.push({ type: "goal", id: `goal-completed-${i + 1}`, title: g, text: g, meta: { state: "completed" } });
  });

  return docs;
}

/** Build a ~140-char snippet around the first query-term hit in the text. */
function snippet(text: string, terms: Set<string>): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= 140) return clean;
  const tokens = tokenize(clean);
  const hit = tokens.findIndex((t) => terms.has(t));
  if (hit === -1) return clean.slice(0, 140).trimEnd() + "…";
  // Map the matching token back to an approximate character offset.
  const approx = tokens.slice(0, hit).join(" ").length;
  const start = Math.max(0, approx - 50);
  const end = Math.min(clean.length, start + 140);
  return (start > 0 ? "…" : "") + clean.slice(start, end).trim() + (end < clean.length ? "…" : "");
}

export interface SearchOptions {
  /** Restrict results to a single document type. */
  type?: SearchType;
  /** Restrict results to a single session/run scope. */
  run?: string;
  /** Maximum number of hits to return (default 10). */
  limit?: number;
}

/**
 * Rank `docs` against `query` with BM25 and return the top hits, highest score
 * first. Documents with no query-term overlap are excluded.
 */
export function bm25Search(
  docs: SearchDoc[],
  query: string,
  opts: SearchOptions = {},
): SearchHit[] {
  let pool = opts.type ? docs.filter((d) => d.type === opts.type) : docs;
  if (opts.run) pool = pool.filter((d) => d.meta?.["runId"] === opts.run);
  const terms = queryTerms(query);
  if (terms.length === 0 || pool.length === 0) return [];

  // Pre-tokenize every document once.
  const tokenized = pool.map((d) => tokenize(d.text));
  const lengths = tokenized.map((toks) => toks.length);
  const avgdl = lengths.reduce((a, b) => a + b, 0) / pool.length || 1;

  // Document frequency per query term.
  const df = new Map<string, number>();
  for (const term of new Set(terms)) {
    let n = 0;
    for (const toks of tokenized) if (toks.includes(term)) n++;
    df.set(term, n);
  }

  const N = pool.length;
  const hits: SearchHit[] = [];
  const termSet = new Set(terms);

  pool.forEach((doc, i) => {
    const toks = tokenized[i]!;
    const len = lengths[i]!;
    // Term frequencies in this document.
    const tf = new Map<string, number>();
    for (const tok of toks) if (termSet.has(tok)) tf.set(tok, (tf.get(tok) ?? 0) + 1);

    let score = 0;
    for (const term of termSet) {
      const f = tf.get(term);
      if (!f) continue;
      const n = df.get(term)!;
      // BM25 IDF, smoothed to stay non-negative.
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const denom = f + K1 * (1 - B + (B * len) / avgdl);
      score += idf * ((f * (K1 + 1)) / denom);
    }

    if (score > 0) {
      hits.push({
        type: doc.type,
        id: doc.id,
        title: doc.title,
        score: Math.round(score * 1000) / 1000,
        snippet: snippet(doc.text, termSet),
        meta: doc.meta ?? {},
      });
    }
  });

  // Sort by score desc; tie-break by id for stable, deterministic ordering.
  hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return hits.slice(0, opts.limit ?? 10);
}

/** Build the corpus from disk and run a BM25 search in one call. */
export function searchProject(
  root: string,
  query: string,
  opts: SearchOptions = {},
): SearchHit[] {
  return bm25Search(buildCorpus(root), query, opts);
}
