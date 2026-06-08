# Where we are

Goal: Ship AJP v0.1
Current: (nothing in progress)

Active decisions:
- SQLite WAL for the store — safe concurrent multi-agent writes _(d1 · 2h)_
- Deterministic BM25 + fileIDF + recency for task→file relevance — no deps, token-free, backtestable on own history; embeddings deferred to a later layer _(d-relevance · 43m)_
- Use blind fixture (wedge-fixture-blind.mjs) for the CONTEXT.md A/B — original fixture leaked 4/5 answer-key facts via code comments, collapsing the control/treatment gap; blind variant moves all intent into the journal so the wedge is measurable _(d-wedge · 28m)_

Open tasks:
- (none)

Next:
1. Break the goal "Ship AJP v0.1" into tasks

Recent activity:
- Decision: AJP core bet = fast-recall, token-cheap memory layer — replace the 300k+ token cold-start repo scan with a small CONTEXT.md read; metric is tokens-to-orient. Passive in/out beats CLAUDE.md and manual CLI logging (which agents skip) — Claude Code _(10m)_
- Decision: Static code graph (imports+exports) for cold-start file relevance — history-less repos get real recall via symbol match + import proximity; fused with co-occurrence, weights self-balance cold vs warm; deterministic, no embeddings — claude-opus _(26m)_
- Decision: Use blind fixture (wedge-fixture-blind.mjs) for the CONTEXT.md A/B — original fixture leaked 4/5 answer-key facts via code comments, collapsing the control/treatment gap; blind variant moves all intent into the journal so the wedge is measurable — Claude Code _(28m)_
- Learned: Token wedge measured: blind fixture 79x cheaper to orient (12835 tok cold scan vs 162 tok CONTEXT.md); this AJP repo 1209x (505k vs 418). Ratio is estimator-independent. Bench: npm run wedge:tokens <dir>. — Claude Code _(10m)_
- Learned: Built: tokens.ts (estimateTokens/compareTokens), token budget in recall.ts (DEFAULT_RECALL_BUDGET=1500, drops low-value sections, footer stamps ~N tokens + drift), and F1 wired relevance ranker into compileContext so CONTEXT.md activity ranks by relevance-to-goal not pure recency (old critical fact survives noise). 143 tests green. — Claude Code _(10m)_

_seq 627 · ~528 tokens · regenerated automatically — do not edit_
