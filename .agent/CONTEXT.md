# Where we are

Goal: Ship Cairn v0.1
Current: (nothing in progress)

Active decisions:
- SQLite WAL for the store — safe concurrent multi-agent writes _(d1 · 15h)_
- Deterministic BM25 + fileIDF + recency for task→file relevance — no deps, token-free, backtestable on own history; embeddings deferred to a later layer _(d-relevance · 14h)_
- Use blind fixture (wedge-fixture-blind.mjs) for the CONTEXT.md A/B — original fixture leaked 4/5 answer-key facts via code comments, collapsing the control/treatment gap; blind variant moves all intent into the journal so the wedge is measurable _(d-wedge · 13h)_

Open tasks:
- (none)

Next:
1. Break the goal "Ship Cairn v0.1" into tasks

Recent activity:
- Decision: Global bootstrap must give npm install path — Agents on other repos hit cairn: command not found and gave up. @memxai/cairn published but bootstrap said skip-silently with no install path. Fix: npm i -g @memxai/cairn + repo URL; bump GLOBAL_RULES_VERSION for self-heal. — Claude Code _(8m)_
- Decision: Capture uncommitted work via cairn sync --working — File-change memory only saved on commit. Gap: agent edits, never commits, next session blind. Fix: provisional file.* events source:working id gitworking:<path>, superseded by commit events; wired to Stop hook. — Claude Code _(8m)_
- Learned: Distribution bug root cause: global bootstrap (GLOBAL_RULES_BODY in src/setup/rules.ts) said skip-silently if cairn missing + asserted it was installed; gave agents no install path → agents on other repos failed setup. Fixed in v3 rules: explicit npm i -g @memxai/cairn + repo URL + never-install-unscoped warning. Package @memxai/cairn already published 0.1.11; needs republish to propagate v3 rules via self-heal. — Claude Code _(now)_
- Learned: cairn sync --working captures uncommitted edits as provisional file.* events (source:working, id gitworking:<path>) so memory survives without a commit; superseded by gitfile:<sha>:<path> on real commit. syncWorking() in src/engines/gitsync.ts. Reports newly-inserted count via store.count() diff (idempotent per path). — Claude Code _(now)_
- Decision: Keep npm postinstall informational by default — Distribution lifecycle scripts should not mutate home shell config or target repos unless CAIRN_SETUP=1 explicitly opts in. — Codex _(11m)_

_seq 2334 · ~576 tokens · regenerated automatically — do not edit_
