# Where we are

Goal: Ship Cairn v0.1
Current: (nothing in progress)

Active decisions:
- SQLite WAL for the store — safe concurrent multi-agent writes _(d1 · 2h)_
- Deterministic BM25 + fileIDF + recency for task→file relevance — no deps, token-free, backtestable on own history; embeddings deferred to a later layer _(d-relevance · 1h)_
- Use blind fixture (wedge-fixture-blind.mjs) for the CONTEXT.md A/B — original fixture leaked 4/5 answer-key facts via code comments, collapsing the control/treatment gap; blind variant moves all intent into the journal so the wedge is measurable _(d-wedge · 55m)_

Open tasks:
- (none)

Next:
1. Break the goal "Ship Cairn v0.1" into tasks

Recent activity:
- Decision: Post-commit hook auto-commits the journal — sync runs after a commit and mutates .agent/, which previously dangled as a dirty tree and never got committed; hook now makes a follow-up chore(cairn): sync journal commit guarded by CAIRN_SKIP_HOOK (no recursion), and gitsync ignores .agent/ so the journal never journals itself — Claude Code _(7m)_
- Learned: Project name is Cairn (npm: cairn; bins: cairn, cairn-mcp). Superseded ajp/agent-journal-protocol and legacy stated. Journal dir stays .agent/. — Claude-rename _(5m)_
- git.commit — abhishek462307 _(now)_
- Modified bin/cairn-mcp.js — abhishek462307 _(now)_
- git.commit — abhishek462307 _(1m)_

_seq 1576 · ~341 tokens · regenerated automatically — do not edit_
