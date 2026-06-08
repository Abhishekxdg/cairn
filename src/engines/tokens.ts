/**
 * Token estimation — the ruler for the whole bet.
 *
 * Cairn's core claim is "replace a big cold-start repo scan with one tiny read."
 * That claim is meaningless without a number, so this is the number: a cheap,
 * dependency-free estimate of how many model tokens a blob of text costs.
 *
 * We deliberately do NOT pull in a real BPE tokenizer (tiktoken/anthropic):
 * - it adds a heavy native/wasm dep Cairn otherwise avoids, and
 * - the product metric is a RATIO (cold-orient tokens ÷ Cairn-orient tokens). Any
 *   consistent estimator cancels its own bias in a ratio, so a good heuristic is
 *   enough to report "~Nx cheaper" honestly.
 *
 * The heuristic blends the two signals that track real BPE output well on code +
 * prose: raw length (~4 chars/token) and word count (~1.3 tokens/word, since
 * punctuation and subword splits add fragments). We take the max so neither
 * dense code (few spaces) nor chatty prose (many short words) under-counts.
 */

const CHARS_PER_TOKEN = 4;
const TOKENS_PER_WORD = 1.3;

/** Estimate the model-token cost of a string. Deterministic, dependency-free. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const byChars = text.length / CHARS_PER_TOKEN;
  const words = text.trim().split(/\s+/).length;
  const byWords = words * TOKENS_PER_WORD;
  return Math.ceil(Math.max(byChars, byWords));
}

/** A token comparison between two orientation paths (the headline stat). */
export interface TokenComparison {
  baselineTokens: number;
  cairnTokens: number;
  /** baseline ÷ cairn, e.g. 18.5 → "18.5x cheaper". 1 if cairn is 0. */
  ratio: number;
  /** Tokens NOT spent by reading Cairn instead of the baseline. */
  saved: number;
}

/**
 * Compare a baseline orientation cost (e.g. a cold repo scan) against the Cairn
 * orientation cost (reading CONTEXT.md). Both measured with the same estimator
 * so the ratio is honest.
 */
export function compareTokens(baselineText: string, cairnText: string): TokenComparison {
  const baselineTokens = estimateTokens(baselineText);
  const cairnTokens = estimateTokens(cairnText);
  return {
    baselineTokens,
    cairnTokens,
    ratio: cairnTokens > 0 ? Number((baselineTokens / cairnTokens).toFixed(1)) : 1,
    saved: Math.max(0, baselineTokens - cairnTokens),
  };
}
