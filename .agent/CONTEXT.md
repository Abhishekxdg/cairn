# Where we are

Goal: Ship Cairn v0.1
Current: (nothing in progress)

Active decisions:
- SQLite WAL for the store — safe concurrent multi-agent writes _(d1 · 14h)_
- Deterministic BM25 + fileIDF + recency for task→file relevance — no deps, token-free, backtestable on own history; embeddings deferred to a later layer _(d-relevance · 13h)_
- Use blind fixture (wedge-fixture-blind.mjs) for the CONTEXT.md A/B — original fixture leaked 4/5 answer-key facts via code comments, collapsing the control/treatment gap; blind variant moves all intent into the journal so the wedge is measurable _(d-wedge · 13h)_

Open tasks:
- (none)

Next:
1. Break the goal "Ship Cairn v0.1" into tasks

Recent activity:
- Decision: Keep npm postinstall informational by default — Distribution lifecycle scripts should not mutate home shell config or target repos unless CAIRN_SETUP=1 explicitly opts in. — Codex _(now)_
- Learned: Known bug: post-commit sync auto-commit can delete .agent under concurrent sessions (race). Workaround CAIRN_NO_AUTOCOMMIT=1. Partial fix 5f7b328 stopped sync hook committing journal deletions. — Claude Code _(9m)_
- code.indexed — cli _(now)_
- code.indexed — cli _(now)_
- code.indexed — cli _(now)_

_seq 2272 · ~304 tokens · regenerated automatically — do not edit_
