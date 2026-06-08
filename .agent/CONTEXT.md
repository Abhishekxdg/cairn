# Where we are

Goal: Ship AJP v0.1
Current: (nothing in progress)

Active decisions:
- SQLite WAL for the store — safe concurrent multi-agent writes _(d1 · 2h)_
- Deterministic BM25 + fileIDF + recency for task→file relevance — no deps, token-free, backtestable on own history; embeddings deferred to a later layer _(d-relevance · 44m)_
- Use blind fixture (wedge-fixture-blind.mjs) for the CONTEXT.md A/B — original fixture leaked 4/5 answer-key facts via code comments, collapsing the control/treatment gap; blind variant moves all intent into the journal so the wedge is measurable _(d-wedge · 30m)_

Open tasks:
- (none)

Next:
1. Break the goal "Ship AJP v0.1" into tasks

Recent activity:
- Created ajp/scripts/wedge-fixture-blind.mjs — abhishek462307 _(now)_
- Created ajp/scripts/wedge-tokens.mjs — abhishek462307 _(now)_
- Modified ajp/docs/experiments/wedge-fixture.md — abhishek462307 _(now)_
- Learned: A2 done: ajp setup now installs a Claude Code SessionStart hook in .claude/settings.json (marker AJP:recall-inject) that cats CONTEXT.md into every session — recall is involuntary, not voluntary. Idempotent merge, preserves existing settings/hooks. installSessionHook() in setup/install.ts. — Claude Code _(4m)_
- Modified .agent/CONTEXT.md — abhishek462307 _(now)_

_seq 738 · ~321 tokens · regenerated automatically — do not edit_
