# Agent Chatroom — Design Spec

**Date:** 2026-06-09
**Status:** Approved design, pending spec review
**Author:** Claude Code (with abhishek)

## Problem

A developer runs multiple AI coding agents at once (Claude Code + Codex, etc.).
They cannot talk to each other — the human is the message bus, copy-pasting output
between tools. Reference product: [agmsg](https://github.com/fujibee/agmsg).

Cairn already gives agents a shared **memory** (the append-only journal). It does
not give them a way to **talk in real time**. This spec adds a realtime chatroom
as a Cairn feature, kept separate from the memory journal.

## Goals

- Agents in the same repo can send each other live messages without the human relaying.
- A message reaches an agent **mid-task**, not only at session start (realtime).
- Chat is **separate** from the memory journal — it must not pollute
  recall / timeline / context.
- One product: ships inside `@memxai/cairn`, reuses the existing SQLite store, install, and MCP server.

## Non-Goals (YAGNI)

- No standalone repo/package. Chat lives in Cairn.
- No network/daemon/server. Local SQLite only (matches Cairn + agmsg).
- No role-exclusivity locks in v1 (see Known Limitations).
- No realtime guarantee for Codex / Gemini / Copilot in v1 (see Scope).

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Feature **inside** Cairn, reuses the store | One product, two capabilities (memory + chat). Least sprawl. |
| 2 | Delivery via **hooks** (SessionStart monitor + Stop turn-mode) | Reaches any tool with a hook system, not just MCP-wired ones. Mirrors agmsg. |
| 3 | **Separate `chat` table** in the same `.agent` db — NOT journal events | Keeps high-volume chat out of memory recall/timeline/context while shipping in one db. |
| 4 | **One room per project, teams inside the room** | Room = the repo's channel; teams = subgroups for parallel work. Address a team, an agent, or broadcast. |
| 5 | v1 ships **Claude Code realtime, proven**; other tools scaffolded behind per-tool spikes | Only Claude Code has documented, stable SessionStart/Stop hooks. Codex/Gemini/Copilot hook support is uneven and unbuilt — promising 4-tool realtime up front would be a guess. |

## Architecture

```
chat table (same .agent SQLite db, separate from `events`)
        │  read/write
   src/engines/chat.ts  ──────────┬──────────────┐
        │                         │              │
  cairn chat CLI            MCP chat tools   delivery hooks
  (send/inbox/tail/         (chat_send /     (per tool:
   teams/history)            chat_wait)       monitor + turn)
```

- **`src/engines/chat.ts`** — pure room/team/message logic over the `chat` table.
  Tool-agnostic. The unit under test.
- **CLI verbs** in `src/cli/index.ts` under a `chat` subcommand.
- **MCP tools** in `src/mcp/server.ts`.
- **Hook wiring** extends `src/setup/install.ts`.

## Data Model

New table, added via a `migrate` step in `src/core/schema.ts`:

```sql
CREATE TABLE IF NOT EXISTS chat (
  id        TEXT PRIMARY KEY,            -- ulid
  room      TEXT NOT NULL,               -- = project id (one room per project)
  team      TEXT,                        -- subgroup; NULL = room-wide
  sender    TEXT NOT NULL,               -- actor name
  recipient TEXT,                        -- actor name, team name, or NULL = broadcast
  body      TEXT NOT NULL,
  ts        INTEGER NOT NULL,            -- epoch ms
  read_by   TEXT NOT NULL DEFAULT '[]'   -- JSON array of actor names who have seen it
);
CREATE INDEX IF NOT EXISTS chat_room_ts  ON chat(room, ts);
CREATE INDEX IF NOT EXISTS chat_room_rcpt ON chat(room, recipient, ts);
```

Team membership is session-local state (which team this agent is acting as),
stored as a lockfile/JSON in the run directory — **never** in the append-only
journal (CLAUDE.md rule 4). Membership is advisory in v1 (no exclusivity).

## Surface

### CLI — `cairn chat <verb>`

| Verb | Args | Behavior |
|------|------|----------|
| `send` | `--to <name\|team>` `--body "…"` `[--team T]` `--actor N` | Insert a message. No `--to` ⇒ broadcast to room. |
| `inbox` | `--actor N` | Unread messages addressed to me / my team / broadcast. Marks them read. |
| `tail` | `--actor N` | Blocking watcher: stream new messages as they arrive (monitor-mode backbone). |
| `teams` | — | List teams seen in the room. |
| `join` | `<team> --actor N` | Set this session's active team. |
| `leave` | `--actor N` | Clear active team. |
| `history` | `[--team T] [--limit N]` | Print recent messages. |

Recipient resolution for `inbox`: a message is "for me" if
`recipient == myActor` OR `recipient == myTeam` OR `recipient IS NULL` (broadcast).
A sender never receives their own messages.

### MCP tools (`src/mcp/server.ts`)

- `chat_send(to?, body, team?)` — send.
- `chat_wait(timeoutMs?)` — long-poll: block until a message for this agent lands, then return it (low-latency path where MCP is wired, e.g. Claude Code).
- `chat_teams()` — list teams / membership.

### Delivery wiring (`src/setup/install.ts`)

- **Claude Code (v1, full):**
  - `SessionStart` hook → spawn `cairn chat tail` (monitor mode).
  - `Stop` hook → `cairn chat inbox` between turns, 60s cooldown (turn mode).
  - Reuse the existing `.claude/settings.json` merge + marker-idempotency logic.
- **Codex / Gemini / Copilot (v1, scaffold only):**
  - Engine + CLI + MCP work for them already (tool-agnostic).
  - Hook wiring is a **per-tool research spike**; until verified, these tools fall
    back to **passive** delivery (messages seen on next `cairn chat inbox` /
    session start). No realtime promise.

## Error Handling & Edge Cases

- **Concurrent writes:** SQLite WAL (existing pragma) — safe multi-agent insert.
- **Poll storms:** 60s cooldown on the Stop-hook turn check.
- **Same actor in two sessions:** both read the message (no exclusivity lock in
  v1). Acceptable; flagged below.
- **Empty/oversized body:** reject empty; cap body length (e.g. 8 KB) to keep the
  table light.
- **No `.agent` / not initialized:** chat commands require an initialized repo, same as other Cairn commands.

## Known Limitations (v1)

- No role-exclusivity locks → duplicate delivery if one actor name runs in two
  sessions. (agmsg's `actas` model is the future fix.)
- Realtime only guaranteed for Claude Code. Other three are passive until their
  hook spikes land.
- No message editing/deletion, no threads, no presence.

## Testing

- **Unit (`chat.ts`):** send → inbox → read roundtrip; team routing; broadcast;
  sender-excluded-from-own-inbox; read_by accumulation.
- **Migration:** `chat` table + indexes created idempotently; existing dbs upgrade.
- **Hook merge:** Claude Code SessionStart/Stop wiring is idempotent (re-running
  setup does not stack duplicates) — extend existing install tests.
- **MCP:** `chat_send` then `chat_wait` returns the message.

## Rollout

1. Migration + `chat.ts` engine + unit tests.
2. CLI `cairn chat` verbs.
3. MCP `chat_send` / `chat_wait` / `chat_teams`.
4. Claude Code hook wiring (monitor + turn) + install tests.
5. Dogfood: two Claude Code sessions in this repo, one room.
6. Follow-on (separate specs): Codex, Gemini, Copilot hook spikes.
```
