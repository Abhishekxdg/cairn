# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project adheres to
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-06-08

### Added

- `.stated/` shared project state format: `project.md`, `goals.md`,
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
- Async `Stated` SDK with agent attribution and heartbeats.
- MCP server (stdio) exposing 13 tools and 4 read-only resources, compatible with
  Claude Code, Codex, Cursor, OpenHands and any MCP client.
- Full vitest suite covering core, SDK, CLI and MCP.
