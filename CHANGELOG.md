# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project adheres to
[Semantic Versioning](https://semver.org/).

## [0.3.0]

### Added

- **Claude Code plugin.** Install Cairn in one step:
  `/plugin marketplace add memxai/cairn` then `/plugin install cairn@cairn`. Wires
  the journal over MCP (via `npx`, no global install required), a SessionStart hook
  that auto-injects `CONTEXT.md`, and `/cairn:recall|anchor|status|setup` commands.
  Lives in `plugin/cairn/` with a repo-root `.claude-plugin/marketplace.json`.
- **`cairn quickstart` — interactive setup wizard.** A zero-dependency arrow-key TUI
  (`src/cli/wizard.ts`) that wires the global bootstrap and sets up the current repo
  in one screen. `cairn setup` now launches it automatically on a TTY; `--yes` keeps
  the old non-interactive path for scripts and agents.
- **Automatic setup on install.** `npm install -g @memxai/cairn` now wires the global
  agent bootstrap automatically, and installing Cairn inside a project sets up that
  repo — no `CAIRN_SETUP=1` opt-in needed. Opt out with `CAIRN_NO_AUTO_SETUP=1`; CI is
  skipped automatically (the git hook's auto-commit is wrong for pipelines).
- **Anchors — memory that doesn't decay.** Pin a foundational fact and it rides in
  every compiled `CONTEXT.md`, ranked by `weight`, never trimmed under the token
  budget. `cairn anchor "<fact>" [--weight N]` and `cairn anchors` (list, highest
  weight first); SDK `journal.anchor(statement, { weight })` / `getAnchors()`;
  `decide({ anchor, weight })` and any `decision.made`/`knowledge.learned` event
  with `anchor:true` (or `durable:true`). When anchors out-grow their sub-budget
  (≤50% of the total) the lowest-weight ones collapse to a `+N more` pointer
  instead of blowing the ceiling. Eval `npm run eval:anchors`: foundational-fact
  retention under budget pressure rises from **36% → 100%** (0/15 → 15/15
  "always-kept" cells).
- **Deep full-system eval harness.** `npm run eval` runs 10 scenarios / 29 invariant
  checks across token-efficiency, snapshot acceleration, relevance, anchors,
  code-graph, compaction, budget adherence, scaling and determinism
  (`eval/cairn.eval.ts`, `eval/anchors.eval.ts`).

### Changed

- **Relevance over recency, wider reach.** Recent-activity ranking now considers a
  bounded candidate pool of the newest `RELEVANCE_POOL` (2000) events, so a fact
  highly relevant to the current goal/decisions can out-rank fresh noise and survive
  into context up to ~2000 events deep (was ~72). Cost stays flat at scale
  (+~8 ms at 50k events); facts older than the pool are kept alive by anchors.

### Fixed

- **Recall token budget is now hard.** Over-long spine lines (goal/current/anchor)
  are clipped to `MAX_SPINE_LINE` (140 chars), and an emergency minimal-mode
  degradation guarantees `cairn recall` stays within budget down to a ~24-token
  skeleton floor — previously a pathologically long goal or a flood of pins could
  overflow the ceiling.

### Changed

- **Renamed the project to Cairn** — an append-only journal for AI agents;
  Git-like memory, without the complexity. Supersedes the earlier `stated` and
  `agent-journal-protocol` (`ajp`) names. The npm package is now `cairn` with
  the `cairn` and `cairn-mcp` binaries; managed agent-rule blocks use
  `CAIRN:BEGIN`/`CAIRN:END` markers and `CAIRN_*` env vars (`CAIRN_ROOT`,
  `CAIRN_ACTOR`, …). The journal directory stays `.agent/` (tool-agnostic, like
  `.git`), so existing journals migrate untouched.

### Added

- **Sub-second recall (BM25 search).** `cairn search <query>` ranks tasks,
  decisions and goals with pure Okapi BM25 — no embeddings, no network, no
  models. Deterministic ordering, `--type`/`--run`/`--limit` filters, and a
  ~140-char snippet per hit. Stays under ~60 ms even at 5k facts / 2 MB, so an
  agent pulls only the relevant memory instead of loading the whole handoff.
  Exposed as the `search_memory` MCP tool and SDK `search()`. `search.ts`
  (`tokenize`/`buildCorpus`/`bm25Search`/`searchProject`); tested in
  `scope.test.ts`.
- **Staleness signal.** Active tasks and file locks now carry `lastVerifiedAt`;
  Cairn derives a `confidence` (`fresh`/`aging`/`stale`) at read time and shows
  it everywhere — `state.json` (`confidence` per fact + a `freshness` summary),
  a handoff banner with inline ages, colorized `cairn status`, and `cairn
  doctor` flagging every stale fact (the rot detector). A fact now decays
  visibly instead of lying.
- **`cairn verify <id|path>`** + `verify_fact` MCP tool + SDK `verifyTask` /
  `verifyFile` / `verify` — re-confirm a fact is still true without editing it,
  resetting its staleness clock.
- **Customizable memory decay (opt-in).** `.agent/config.json` configures
  `staleness` thresholds and a `decay` policy (auto-release abandoned locks,
  archive long-completed tasks, trim the event log). All policies default to `0`
  (off). `cairn decay` runs a dry run; `--apply` performs the cleanup, archiving
  to `.agent/snapshots/`. Exposed as the `run_decay` MCP tool and SDK `decay()`.
- New event types `memory_verified`, `memory_decayed`.
- `config.ts` (`loadConfig`/`writeConfig`/`DEFAULT_CONFIG`), `staleness.ts`
  (`confidenceFor`/`viewTask`/`viewFile`/`summarize`/`ageLabel`), `decay.ts`
  (`applyDecay`). Test suites `staleness.test.ts` + `decay.test.ts`.

### Notes

- `Task.lastVerifiedAt` / `FileOwnership.lastVerifiedAt` are optional; legacy
  `.agent/` data falls back to `updatedAt` / `claimedAt`. No migration needed.

## [0.1.12] - 2026-06-09

### Fixed

- **Global bootstrap now gives agents a real install path.** The bootstrap block
  written into `~/.claude/CLAUDE.md` (and other agents' global rules) previously
  asserted Cairn was already installed and told agents to "skip silently" if the
  `cairn` command was missing — leaving agents on a fresh machine stranded when a
  user asked to "setup cairn". It now states the package is `@memxai/cairn`, gives
  the install command `npm i -g @memxai/cairn`, links the repo, and warns never to
  install an unscoped `cairn`. `GLOBAL_RULES_VERSION` bumped to 3, so existing
  installs self-heal on the next `cairn sync`.

### Added

- **`cairn sync --working`** captures *uncommitted* edits as provisional
  `file.created`/`file.modified`/`file.deleted` events (tagged `source: "working"`,
  id keyed by path), so in-flight work survives a session even when nothing is
  committed. The events are idempotent per path and are naturally superseded by the
  authoritative `gitfile:<sha>:<path>` event once the real commit lands. Closes the
  gap where an agent that edited files but never committed left no file-memory
  behind. Added `repository`/`homepage`/`bugs` metadata to `package.json`.

## [0.1.0] - 2026-06-08

### Added

- `.agent/` shared project state format: `project.md`, `goals.md`,
  `tasks.json`, `decisions.md`, `agents.json`, `files.json`, `handoff.md`,
  `state.json`, `events.jsonl`, and `snapshots/`.
- Crash-safe, Git-friendly file IO (atomic temp-file + `fsync` + rename).
- Append-only event stream (`events.jsonl`) as the canonical history; decisions
  are reconstructed from it and rendered to `decisions.md`.
- Snapshot engine that auto-regenerates `handoff.md` and `state.json` after every
  mutation, plus timestamped restore points.
- Zero-dependency, no-network framework detection: Next.js, React, Vue, Angular,
  Express, Fastify, Laravel, Django, Flask.
- CLI: `init`, `status`, `state`, `handoff`, `goal`, `task`, `decision`,
  `agent`, `file`, `snapshot`, `doctor`, `mcp`.
- Async `Cairn` SDK with agent attribution and heartbeats.
- MCP server (stdio) exposing 13 tools and 4 read-only resources, compatible with
  Claude Code, Codex, Cursor, OpenHands and any MCP client.
- Full vitest suite covering core, SDK, CLI and MCP.
