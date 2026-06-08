# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
