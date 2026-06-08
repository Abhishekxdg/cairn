# MCP Server

Cairn ships a first-class MCP server so any MCP-compatible client (Claude Code,
Codex, Cursor, OpenHands) reads and writes the same journal.

## Run

```bash
cairn mcp           # via the CLI
cairn-mcp           # dedicated binary
```

The server operates on the project at `CAIRN_ROOT` (env) or the directory it is
launched from.

## Register

### Claude Code

```bash
claude mcp add cairn -- cairn mcp
```

### Cursor / generic

```json
{
  "mcpServers": {
    "cairn": {
      "command": "cairn",
      "args": ["mcp"],
      "env": { "CAIRN_ROOT": "/abs/path/to/project" }
    }
  }
}
```

## Tools

| Tool | Purpose |
|---|---|
| `append_event` | Append an immutable event (the only way to change state) |
| `query_state` | Full derived state |
| `query_context` | Minimum-token compiled context (`level`: small/medium/large/full) |
| `query_memory` | Derived memory entries |
| `query_timeline` | Day-grouped human timeline (`sinceSeq`, `type`) |
| `register_agent` | Record `agent.registered` |
| `create_snapshot` | Force a snapshot |
| `get_active_tasks` | Active (non-completed/archived) tasks |
| `get_active_decisions` | Decisions currently in force |

## Resources

| URI | Content |
|---|---|
| `cairn://state` | Derived state JSON |
| `cairn://context` | Compiled medium context JSON |

## Recommended agent loop

1. `register_agent` at session start.
2. `query_context` (or read `cairn://context`) to prime context cheaply.
3. As you work, `append_event` for each meaningful change —
   `task.created`, `task.completed`, `decision.made`, `file.modified`,
   `knowledge.learned`, `agent.heartbeat`.
4. Read `get_active_tasks` / `get_active_decisions` before acting so you never
   duplicate another agent's work.

Every tool call is durable, concurrency-safe, and attributable — the journal is
the shared source of truth across all agents.
