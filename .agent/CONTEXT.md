# Where we are

Goal: Ship AJP v0.1
Current: (nothing in progress)

Active decisions:
- SQLite WAL for the store — safe concurrent multi-agent writes _(d1 · 2h)_
- Deterministic BM25 + fileIDF + recency for task→file relevance — no deps, token-free, backtestable on own history; embeddings deferred to a later layer _(d-relevance · 45m)_
- Use blind fixture (wedge-fixture-blind.mjs) for the CONTEXT.md A/B — original fixture leaked 4/5 answer-key facts via code comments, collapsing the control/treatment gap; blind variant moves all intent into the journal so the wedge is measurable _(d-wedge · 31m)_

Open tasks:
- (none)

Next:
1. Break the goal "Ship AJP v0.1" into tasks

Recent activity:
- Created ajp/scripts/wedge-fixture-blind.mjs — abhishek462307 _(1m)_
- Modified .agent/CONTEXT.md — abhishek462307 _(now)_
- Created ajp/scripts/wedge-tokens.mjs — abhishek462307 _(1m)_
- Modified ajp/docs/experiments/wedge-fixture.md — abhishek462307 _(1m)_
- Modified .agent/CONTEXT.md — abhishek462307 _(1m)_

_seq 788 · ~253 tokens · regenerated automatically — do not edit_
