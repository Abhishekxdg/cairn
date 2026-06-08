# Contributing to Stated

Thanks for helping build the shared state layer for AI coding agents.

## Getting started

```bash
git clone https://github.com/stated-dev/stated.git
cd stated
npm install
npm run build
npm test
```

## Project layout

```text
src/core/   Canonical synchronous file API. One module per .stated file:
            project.ts, goals.ts, tasks.ts, decisions.ts, agents.ts,
            files.ts, events.ts, snapshot.ts, init.ts, doctor.ts.
            All on-disk types live in types.ts; all IO in io.ts (atomic + fsync).
src/sdk/    The ergonomic async `Stated` class. Thin wrapper over core.
src/cli/    Dependency-free arg parser + command handlers.
src/mcp/    MCP server exposing core as tools + resources.
test/       Vitest suites covering core, sdk, cli and mcp.
```

## Principles to preserve

- **The repository is the source of truth.** Never introduce a database, cloud
  service, network call, model, or embedding.
- **Human- and AI-readable, merge-friendly.** Markdown for humans, pretty JSON
  for machines, append-only `events.jsonl` for history.
- **Crash-safe writes.** All writes go through `io.ts` (temp file + fsync +
  rename). Don't write files directly.
- **Derived files are derived.** `handoff.md` and `state.json` are regenerated
  by `snapshot.ts` — never hand-edit them and never make them canonical.

## Adding a command / tool

1. Implement the behavior in the relevant `src/core/*.ts` module (it should
   append an event and call `regenerate`).
2. Surface it in the SDK (`src/sdk/index.ts`).
3. Wire it into the CLI (`src/cli/index.ts`) and the MCP server
   (`src/mcp/server.ts`).
4. Add tests in `test/`.

## Before opening a PR

```bash
npm run typecheck
npm test
```

Keep the public API documented and the README in sync. By contributing you agree
to license your work under the MIT License.
