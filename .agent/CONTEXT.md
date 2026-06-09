# Where we are

Goal: Ship Cairn v0.1
Current: (nothing in progress)

Anchors:
- (decision) Fix relevance window (C) and budget hardness (H) — C: relevance re-ranking saw only ~72 newest events; widened candidate pool to… _(24m)_
- (fact) Deep full-system eval harness lives at eval/cairn.eval.ts: 10 scenarios (token-efficiency, snapshot accel, recall fidelity, anchors, file… _(32m)_
- (decision) Rank anchors by weight under a sub-budget — Anchors in the non-droppable spine blew the token budget past ~100 pins. Fix: weight field on… _(42m)_
- (decision) Add memory residual (anchors) — Long journals wash out foundational facts; anchored decisions + durable knowledge get a guaranteed… _(1h)_

Active decisions:
- SQLite WAL for the store — safe concurrent multi-agent writes _(d1 · 16h)_
- Deterministic BM25 + fileIDF + recency for task→file relevance — no deps, token-free, backtestable on own history; embeddings deferred to a later layer _(d-relevance · 15h)_
- Use blind fixture (wedge-fixture-blind.mjs) for the CONTEXT.md A/B — original fixture leaked 4/5 answer-key facts via code comments, collapsing the control/treatment gap; blind variant moves all intent into the journal so the wedge is measurable _(d-wedge · 15h)_

Open tasks:
- (none)

Next:
1. Break the goal "Ship Cairn v0.1" into tasks

Recent activity:
- Decision: Fix relevance window (C) and budget hardness (H) — C: relevance re-ranking saw only ~72 newest events; widened candidate pool to RELEVANCE_POOL=2000 (bounded, +8ms at 50k) so a relevant old fact 1000-deep is rescued; beyond 2000 anchors still required. H: recall budget was best-effort because the spine printed the full goal+>=1 anchor; added spine-line clipping (MAX_SPINE_LINE=140) + emergency minimal-mode degradation so budget is hard down to a ~24t skeleton floor. — Claude Code _(24m)_
- Decision: Postinstall asks before wiring EXISTING repos; builds codegraph on consent — Silent auto-wire of repos with prior history is surprising; gate it. Existing = git repo with commits at install. New/empty repos still wire silently. Prompt only when TTY (stdin+stdout) and not CI; non-interactive installs print a hint and wire nothing, so npm install never hangs. On yes, run indexRepo() so cairn relevant works immediately. cairn setup builds index by default (running it IS consent). — Claude Code _(13h)_
- Decision: Rank anchors by weight under a sub-budget — Anchors in the non-droppable spine blew the token budget past ~100 pins. Fix: weight field on anchors, ranked highest-first, filled within an anchor sub-budget (50% of total); overflow collapses to a +N pointer (cairn anchors). Budget contract holds at any pin count; top-weighted pin always survives. — Claude Code _(42m)_
- Decision: Post-commit hook auto-commits the journal — sync runs after a commit and mutates .agent/, which previously dangled as a dirty tree and never got committed; hook now makes a follow-up chore(cairn): sync journal commit guarded by CAIRN_SKIP_HOOK (no recursion), and gitsync ignores .agent/ so the journal never journals itself — Claude Code _(14h)_
- Decision: Global bootstrap must give npm install path — Agents on other repos hit cairn: command not found and gave up. @memxai/cairn published but bootstrap said skip-silently with no install path. Fix: npm i -g @memxai/cairn + repo URL; bump GLOBAL_RULES_VERSION for self-heal. — Claude Code _(2h)_

_seq 2751 · ~849 tokens · regenerated automatically — do not edit_
