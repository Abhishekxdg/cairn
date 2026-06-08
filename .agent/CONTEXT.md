# Where we are

Goal: Ship AJP v0.1
Current: (nothing in progress)

Active decisions:
- SQLite WAL for the store — safe concurrent multi-agent writes _(d1 · 2h)_
- Deterministic BM25 + fileIDF + recency for task→file relevance — no deps, token-free, backtestable on own history; embeddings deferred to a later layer _(d-relevance · 59m)_
- Use blind fixture (wedge-fixture-blind.mjs) for the CONTEXT.md A/B — original fixture leaked 4/5 answer-key facts via code comments, collapsing the control/treatment gap; blind variant moves all intent into the journal so the wedge is measurable _(d-wedge · 45m)_

Open tasks:
- (none)

Next:
1. Break the goal "Ship AJP v0.1" into tasks

Recent activity:
- Decision: Project name = Cairn — append-only journal for AI agents; git-like memory without complexity. Replaces ajp/agent-journal-protocol and legacy stated. Keep .agent/ dir (tool-agnostic). npm name cairn, bins cairn + cairn-mcp. — Claude-rename _(5m)_
- Task created: Rebrand ajp/agent-journal-protocol -> Cairn; delete legacy stated; flatten ajp/ to root — Claude-rename _(5m)_
- Task started: rename-cairn — Claude-rename _(5m)_
- Modified .agent/CONTEXT.md — abhishek462307 _(13m)_
- Modified .agent/CONTEXT.md — abhishek462307 _(14m)_

_seq 1078 · ~311 tokens · regenerated automatically — do not edit_
