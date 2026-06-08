# Where we are

Goal: Ship Cairn v0.1
Current: (nothing in progress)

Active decisions:
- SQLite WAL for the store — safe concurrent multi-agent writes _(d1 · 3h)_
- Deterministic BM25 + fileIDF + recency for task→file relevance — no deps, token-free, backtestable on own history; embeddings deferred to a later layer _(d-relevance · 2h)_
- Use blind fixture (wedge-fixture-blind.mjs) for the CONTEXT.md A/B — original fixture leaked 4/5 answer-key facts via code comments, collapsing the control/treatment gap; blind variant moves all intent into the journal so the wedge is measurable _(d-wedge · 1h)_

Open tasks:
- (none)

Next:
1. Break the goal "Ship Cairn v0.1" into tasks

Recent activity:
- Decision: Post-commit hook auto-commits the journal — sync runs after a commit and mutates .agent/, which previously dangled as a dirty tree and never got committed; hook now makes a follow-up chore(cairn): sync journal commit guarded by CAIRN_SKIP_HOOK (no recursion), and gitsync ignores .agent/ so the journal never journals itself — Claude Code _(27m)_
- Decision: Publish as @memxai/cairn — unscoped cairn squatted by abandoned RN styling lib (last touched 2022); npm dispute slow/unreliable. Scope @memxai owns namespace, bins stay cairn/cairn-mcp so UX unchanged. — Claude Code _(11m)_
- Learned: Project name is Cairn (npm: cairn; bins: cairn, cairn-mcp). Superseded ajp/agent-journal-protocol and legacy stated. Journal dir stays .agent/. — Claude-rename _(26m)_
- Learned: Cairn v0.1 shipped to npm as @memxai/cairn@0.1.3 (scope memxai, owned by abhishekxdg). 0.1.2 unpublished — it leaked dist sourcemaps + scripts/ eval-wedge source. 0.1.3 ships dist JS+types+docs only (79 files). bins: cairn, cairn-mcp. — Claude Code _(now)_
- Learned: Merged feat/ajp-task-relevant-files into main (ff, 11 commits): Cairn rename + relevance recall + journal-commit fixes. v0.1 code complete, 155/155 tests pass. — Claude Code _(17m)_

_seq 1580 · ~484 tokens · regenerated automatically — do not edit_
