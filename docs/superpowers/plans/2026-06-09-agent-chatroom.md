# Agent Chatroom Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a realtime agent-to-agent chatroom to Cairn — one room per project, teams inside it, stored in a separate `chat` table, with Claude Code realtime delivery via hooks.

**Architecture:** A pure engine (`src/engines/chat.ts`) operates on a new `chat` table in the existing `.agent` SQLite db (added via schema migration v3 — separate from the `events` journal, so chat never pollutes memory recall). CLI verbs (`cairn chat …`), MCP tools (`chat_send`/`chat_wait`/`chat_teams`), and Claude Code SessionStart/Stop hook wiring sit on top. Codex/Gemini/Copilot delivery is deferred to follow-on specs; the engine is already tool-agnostic.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), better-sqlite3 (synchronous), vitest, zod (MCP schemas), `@modelcontextprotocol/sdk`.

**Spec:** `docs/superpowers/specs/2026-06-09-agent-chatroom-design.md`

**Branch:** `feat/agent-chatroom` (already created).

**Conventions in this repo (read before starting):**
- ESM with explicit `.js` suffixes on relative imports, even from `.ts` files.
- IDs via `ulid()` from `src/core/ids.ts`. Timestamps: `Date.now()` (epoch ms) for chat rows.
- The store exposes a public `db: Database` (better-sqlite3) and `projectId: string`. The **room is always `store.projectId`**.
- Tests use `memStore()` / `fileStore()` from `test/helpers.ts`. Run the suite with `npm test` (vitest). Typecheck with `npx tsc --noEmit`.
- Migrations are append-only: add a new entry to `MIGRATIONS`, bump `SCHEMA_VERSION`. Never edit a released migration.
- The `chat` table lives only in the SQLite db (which is a git-ignored cache rebuilt from `events.jsonl`). Chat is intentionally ephemeral across a db rebuild — do NOT mirror it to jsonl.

---

## File Structure

- **Create** `src/engines/chat.ts` — pure chat engine: types + `sendMessage`, `inbox`, `history`, `listTeams`. One responsibility: chat rows in/out. No CLI/MCP/IO beyond the db handle + a membership helper.
- **Create** `src/engines/chat-membership.ts` — session-local active-team storage (a JSON file under the run dir). Kept separate so the engine stays pure and testable without filesystem.
- **Modify** `src/core/schema.ts` — add migration v3 (`chat` table + indexes), bump `SCHEMA_VERSION` to 3.
- **Modify** `src/cli/index.ts` — add a `chat` command that routes sub-verbs.
- **Modify** `src/mcp/server.ts` — add `chat_send`, `chat_wait`, `chat_teams` tools.
- **Modify** `src/setup/install.ts` — wire Claude Code SessionStart (`chat tail`) + Stop (`chat inbox`) hooks.
- **Create** `test/chat.test.ts` — engine unit tests.
- **Create** `test/chat-migration.test.ts` — migration idempotency test.
- **Modify** `test/setup.test.ts` — Claude Code chat-hook idempotency.

---

## Task 1: Schema migration v3 — `chat` table

**Files:**
- Modify: `src/core/schema.ts:13` (SCHEMA_VERSION), `src/core/schema.ts:23-79` (MIGRATIONS array — append)
- Test: `test/chat-migration.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `test/chat-migration.test.ts`:

```ts
import { describe, it, expect, afterAll } from "vitest";
import { memStore } from "./helpers.js";
import { cleanupAll } from "./helpers.js";

afterAll(cleanupAll);

describe("chat table migration (v3)", () => {
  it("creates the chat table with expected columns", () => {
    const s = memStore();
    const cols = (s.db.prepare("PRAGMA table_info(chat)").all() as Array<{ name: string }>)
      .map((c) => c.name)
      .sort();
    s.close();
    expect(cols).toEqual(
      ["body", "id", "read_by", "recipient", "room", "sender", "team", "ts"].sort(),
    );
  });

  it("is idempotent — opening an already-migrated db does not throw", () => {
    const s = memStore();
    // migrate() already ran in the constructor; running again is a no-op.
    expect(() => s.db.exec("SELECT 1 FROM chat LIMIT 0")).not.toThrow();
    s.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/chat-migration.test.ts`
Expected: FAIL — `no such table: chat`.

- [ ] **Step 3: Add the migration**

In `src/core/schema.ts`, change `export const SCHEMA_VERSION = 2;` to `= 3;`. Then append to the `MIGRATIONS` array (after the version-2 entry, before the closing `];`):

```ts
  {
    version: 3,
    description: "chat table for realtime agent messaging (separate from events)",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS chat (
          id        TEXT    PRIMARY KEY,
          room      TEXT    NOT NULL,
          team      TEXT,
          sender    TEXT    NOT NULL,
          recipient TEXT,
          body      TEXT    NOT NULL,
          ts        INTEGER NOT NULL,
          read_by   TEXT    NOT NULL DEFAULT '[]'
        );
        CREATE INDEX IF NOT EXISTS idx_chat_room_ts   ON chat(room, ts);
        CREATE INDEX IF NOT EXISTS idx_chat_room_rcpt ON chat(room, recipient, ts);
      `);
    },
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/chat-migration.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/schema.ts test/chat-migration.test.ts
git commit -m "feat(chat): add chat table migration (schema v3)"
```

---

## Task 2: Chat engine — send + inbox roundtrip

**Files:**
- Create: `src/engines/chat.ts`
- Test: `test/chat.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `test/chat.test.ts`:

```ts
import { describe, it, expect, afterAll } from "vitest";
import { memStore, cleanupAll } from "./helpers.js";
import { sendMessage, inbox } from "../src/engines/chat.js";

afterAll(cleanupAll);

describe("chat engine — send + inbox", () => {
  it("delivers a directed message to its recipient and marks it read", () => {
    const s = memStore("proj1");
    sendMessage(s.db, { room: "proj1", sender: "Claude", to: "Codex", body: "your turn" });

    const first = inbox(s.db, { room: "proj1", actor: "Codex" });
    expect(first.map((m) => m.body)).toEqual(["your turn"]);
    expect(first[0]!.sender).toBe("Claude");

    // Reading is idempotent: a second inbox call returns nothing new.
    const second = inbox(s.db, { room: "proj1", actor: "Codex" });
    expect(second).toEqual([]);
    s.close();
  });

  it("never returns a message to its own sender", () => {
    const s = memStore("proj1");
    sendMessage(s.db, { room: "proj1", sender: "Claude", to: "Codex", body: "hi" });
    expect(inbox(s.db, { room: "proj1", actor: "Claude" })).toEqual([]);
    s.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/chat.test.ts`
Expected: FAIL — cannot find module `../src/engines/chat.js`.

- [ ] **Step 3: Write the minimal engine**

Create `src/engines/chat.ts`:

```ts
import type { Database } from "better-sqlite3";
import { ulid } from "../core/ids.js";

/** A chat message row, decoded. */
export interface ChatMessage {
  id: string;
  room: string;
  team: string | null;
  sender: string;
  recipient: string | null; // actor name, team name, or null = broadcast
  body: string;
  ts: number; // epoch ms
  readBy: string[]; // actors who have seen it
}

/** Max body length, to keep the table light. */
export const MAX_BODY = 8192;

interface Row {
  id: string;
  room: string;
  team: string | null;
  sender: string;
  recipient: string | null;
  body: string;
  ts: number;
  read_by: string;
}

function decode(r: Row): ChatMessage {
  return {
    id: r.id,
    room: r.room,
    team: r.team,
    sender: r.sender,
    recipient: r.recipient,
    body: r.body,
    ts: r.ts,
    readBy: JSON.parse(r.read_by) as string[],
  };
}

export interface SendInput {
  room: string;
  sender: string;
  body: string;
  to?: string; // actor or team; omit for a room-wide broadcast
  team?: string; // tag the message as belonging to a team channel
}

/** Insert a chat message. Returns the stored message. */
export function sendMessage(db: Database, input: SendInput): ChatMessage {
  const body = input.body.trim();
  if (!body) throw new Error("chat message body is empty");
  if (body.length > MAX_BODY) throw new Error(`chat message exceeds ${MAX_BODY} chars`);
  const row: Row = {
    id: ulid(),
    room: input.room,
    team: input.team ?? null,
    sender: input.sender,
    recipient: input.to ?? null,
    body,
    ts: Date.now(),
    read_by: "[]",
  };
  db.prepare(
    `INSERT INTO chat (id, room, team, sender, recipient, body, ts, read_by)
     VALUES (@id, @room, @team, @sender, @recipient, @body, @ts, @read_by)`,
  ).run(row);
  return decode(row);
}

export interface InboxInput {
  room: string;
  actor: string;
  team?: string; // the team this actor is currently acting as
}

/**
 * Return unread messages addressed to `actor` (directly, via their team, or via
 * broadcast), excluding their own messages, and mark them read. "Unread" means
 * `actor` is not yet in the message's `read_by`.
 */
export function inbox(db: Database, input: InboxInput): ChatMessage[] {
  const rows = db
    .prepare(
      `SELECT * FROM chat
       WHERE room = ? AND sender != ?
         AND ( recipient IS NULL OR recipient = ? OR (? IS NOT NULL AND recipient = ?) )
       ORDER BY ts ASC`,
    )
    .all(input.room, input.actor, input.actor, input.team ?? null, input.team ?? null) as Row[];

  const fresh: ChatMessage[] = [];
  const mark = db.prepare("UPDATE chat SET read_by = ? WHERE id = ?");
  const tx = db.transaction((rs: Row[]) => {
    for (const r of rs) {
      const readBy = JSON.parse(r.read_by) as string[];
      if (readBy.includes(input.actor)) continue;
      readBy.push(input.actor);
      mark.run(JSON.stringify(readBy), r.id);
      fresh.push(decode({ ...r, read_by: JSON.stringify(readBy) }));
    }
  });
  tx(rows);
  return fresh;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/chat.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add src/engines/chat.ts test/chat.test.ts
git commit -m "feat(chat): send + inbox engine with read tracking"
```

---

## Task 3: Chat engine — broadcast, teams, history

**Files:**
- Modify: `src/engines/chat.ts` (append `history`, `listTeams`)
- Test: `test/chat.test.ts` (append cases)

- [ ] **Step 1: Write the failing tests**

Append to `test/chat.test.ts`:

```ts
import { history, listTeams } from "../src/engines/chat.js";

describe("chat engine — broadcast, teams, history", () => {
  it("delivers a broadcast (no recipient) to everyone but the sender", () => {
    const s = memStore("p");
    sendMessage(s.db, { room: "p", sender: "Claude", body: "standup in 5" });
    expect(inbox(s.db, { room: "p", actor: "Codex" }).map((m) => m.body)).toEqual(["standup in 5"]);
    expect(inbox(s.db, { room: "p", actor: "Gemini" }).map((m) => m.body)).toEqual(["standup in 5"]);
    expect(inbox(s.db, { room: "p", actor: "Claude" })).toEqual([]);
    s.close();
  });

  it("routes a team-addressed message to members acting as that team", () => {
    const s = memStore("p");
    sendMessage(s.db, { room: "p", sender: "Claude", to: "frontend", body: "ship the navbar" });
    // An agent acting as the frontend team receives it.
    expect(inbox(s.db, { room: "p", actor: "Codex", team: "frontend" }).map((m) => m.body))
      .toEqual(["ship the navbar"]);
    // An agent NOT on that team (and not named frontend) does not.
    expect(inbox(s.db, { room: "p", actor: "Gemini", team: "backend" })).toEqual([]);
    s.close();
  });

  it("history returns recent messages newest-last, optionally per team", () => {
    const s = memStore("p");
    sendMessage(s.db, { room: "p", sender: "Claude", body: "a" });
    sendMessage(s.db, { room: "p", sender: "Claude", to: "frontend", team: "frontend", body: "b" });
    expect(history(s.db, { room: "p" }).map((m) => m.body)).toEqual(["a", "b"]);
    expect(history(s.db, { room: "p", team: "frontend" }).map((m) => m.body)).toEqual(["b"]);
    s.close();
  });

  it("listTeams returns distinct non-null team tags seen in the room", () => {
    const s = memStore("p");
    sendMessage(s.db, { room: "p", sender: "Claude", team: "frontend", body: "x" });
    sendMessage(s.db, { room: "p", sender: "Claude", team: "backend", body: "y" });
    sendMessage(s.db, { room: "p", sender: "Claude", body: "z" });
    expect(listTeams(s.db, "p").sort()).toEqual(["backend", "frontend"]);
    s.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/chat.test.ts`
Expected: FAIL — `history`/`listTeams` not exported.

- [ ] **Step 3: Implement history + listTeams**

Append to `src/engines/chat.ts`:

```ts
export interface HistoryInput {
  room: string;
  team?: string;
  limit?: number;
}

/** Recent messages in the room (oldest→newest within the returned window). */
export function history(db: Database, input: HistoryInput): ChatMessage[] {
  const limit = input.limit ?? 50;
  const rows = (
    input.team
      ? db
          .prepare("SELECT * FROM chat WHERE room = ? AND team = ? ORDER BY ts DESC LIMIT ?")
          .all(input.room, input.team, limit)
      : db
          .prepare("SELECT * FROM chat WHERE room = ? ORDER BY ts DESC LIMIT ?")
          .all(input.room, limit)
  ) as Row[];
  return rows.reverse().map(decode);
}

/** Distinct team tags that have appeared in the room. */
export function listTeams(db: Database, room: string): string[] {
  const rows = db
    .prepare("SELECT DISTINCT team FROM chat WHERE room = ? AND team IS NOT NULL")
    .all(room) as Array<{ team: string }>;
  return rows.map((r) => r.team);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/chat.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/engines/chat.ts test/chat.test.ts
git commit -m "feat(chat): broadcast, team routing, history, listTeams"
```

---

## Task 4: Session-local team membership

**Files:**
- Create: `src/engines/chat-membership.ts`
- Test: `test/chat.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `test/chat.test.ts`:

```ts
import { setActiveTeam, getActiveTeam, clearActiveTeam } from "../src/engines/chat-membership.js";
import { tempDir } from "./helpers.js";

describe("chat membership (session-local active team)", () => {
  it("round-trips an actor's active team under a root dir", () => {
    const dir = tempDir();
    expect(getActiveTeam(dir, "Codex")).toBeUndefined();
    setActiveTeam(dir, "Codex", "frontend");
    expect(getActiveTeam(dir, "Codex")).toBe("frontend");
    clearActiveTeam(dir, "Codex");
    expect(getActiveTeam(dir, "Codex")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/chat.test.ts -t "chat membership"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement membership**

Create `src/engines/chat-membership.ts`:

```ts
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Active-team membership is SESSION-LOCAL, not journal state: it records which
 * team an agent is currently acting as. Stored as one tiny JSON file per actor
 * under `<root>/.agent/run/chat/`, NOT in the append-only journal (CLAUDE.md
 * rule 4 — the journal is for durable intent, not transient session state).
 */
function dir(root: string): string {
  return join(root, ".agent", "run", "chat");
}
function file(root: string, actor: string): string {
  // Sanitize actor into a safe filename.
  const safe = actor.replace(/[^A-Za-z0-9_.-]/g, "_");
  return join(dir(root), `team-${safe}.json`);
}

export function setActiveTeam(root: string, actor: string, team: string): void {
  mkdirSync(dir(root), { recursive: true });
  writeFileSync(file(root, actor), JSON.stringify({ team }), "utf8");
}

export function getActiveTeam(root: string, actor: string): string | undefined {
  const f = file(root, actor);
  if (!existsSync(f)) return undefined;
  try {
    const team = (JSON.parse(readFileSync(f, "utf8")) as { team?: string }).team;
    return team || undefined;
  } catch {
    return undefined;
  }
}

export function clearActiveTeam(root: string, actor: string): void {
  rmSync(file(root, actor), { force: true });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/chat.test.ts -t "chat membership"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engines/chat-membership.ts test/chat.test.ts
git commit -m "feat(chat): session-local active-team membership"
```

---

## Task 5: CLI — `cairn chat` verbs

**Files:**
- Modify: `src/cli/index.ts` (add imports; add `chat` handler to `commands`; add help line)

- [ ] **Step 1: Write the failing test**

Create `test/chat-cli.test.ts`:

```ts
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tempDir, cleanupAll } from "./helpers.js";

afterAll(cleanupAll);

const BIN = join(process.cwd(), "bin", "cairn.js");
function cairn(dir: string, args: string[]): string {
  return execFileSync("node", [BIN, ...args], { cwd: dir, encoding: "utf8" });
}

describe("cairn chat CLI", () => {
  it("send then inbox delivers across actors", () => {
    const dir = tempDir();
    cairn(dir, ["init", "--no-agents", "--no-index"]);
    cairn(dir, ["chat", "send", "--to", "Codex", "--body", "ping", "--actor", "Claude"]);
    const out = cairn(dir, ["chat", "inbox", "--actor", "Codex"]);
    expect(out).toContain("ping");
    expect(out).toContain("Claude");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npx vitest run test/chat-cli.test.ts`
(The CLI test runs the built `bin/cairn.js`, so build first.)
Expected: FAIL — `Unknown command: chat`.

- [ ] **Step 3: Implement the `chat` command**

In `src/cli/index.ts`, add imports near the other engine imports (around line 9-18):

```ts
import { sendMessage, inbox, history, listTeams } from "../engines/chat.js";
import { setActiveTeam, getActiveTeam, clearActiveTeam } from "../engines/chat-membership.js";
```

Add a help line in the `COMMANDS` block of `HELP` (after the `mcp` line, line ~101):

```
  chat <verb>                Realtime agent chat (send|inbox|tail|history|teams|join|leave)
```

Add this handler to the `commands` object (anywhere among the other handlers):

```ts
  chat(rest, flags) {
    const verb = rest[0];
    const root = requireRoot();
    const actor = actorOf(flags);
    const store = openStore();
    const room = store.projectId;
    const myTeam = getActiveTeam(root, actor);
    try {
      switch (verb) {
        case "send": {
          const body = (fstr(flags, "body") ?? rest.slice(1).join(" ")).trim();
          if (!body) throw new Error('chat send requires --body "<message>"');
          const to = fstr(flags, "to");
          const team = fstr(flags, "team") ?? myTeam;
          const m = sendMessage(store.db, {
            room, sender: actor, body,
            ...(to ? { to } : {}),
            ...(team ? { team } : {}),
          });
          if (flags["json"]) return out(JSON.stringify(m, null, 2));
          out(c.dim(`→ sent ${c.cyan(m.id.slice(-6))}${to ? ` to ${to}` : " (broadcast)"}`));
          return;
        }
        case "inbox": {
          const msgs = inbox(store.db, { room, actor, ...(myTeam ? { team: myTeam } : {}) });
          if (flags["json"]) return out(JSON.stringify(msgs, null, 2));
          if (!msgs.length) return out(c.dim("No new messages."));
          for (const m of msgs) {
            const tag = m.recipient && m.recipient !== actor ? ` @${m.recipient}` : "";
            out(`${c.cyan(m.sender)}${c.dim(tag)}: ${m.body}`);
          }
          return;
        }
        case "tail": {
          // Blocking monitor loop: drain inbox, print, sleep, repeat.
          const intervalMs = fstr(flags, "interval") ? Number(fstr(flags, "interval")) : 2000;
          out(c.dim(`tailing chat as ${actor}${myTeam ? ` (${myTeam})` : ""} — Ctrl-C to stop`));
          const tick = () => {
            const msgs = inbox(store.db, { room, actor, ...(myTeam ? { team: myTeam } : {}) });
            for (const m of msgs) out(`${c.cyan(m.sender)}: ${m.body}`);
          };
          return new Promise<void>((resolve) => {
            const timer = setInterval(tick, intervalMs);
            const stop = () => { clearInterval(timer); store.close(); resolve(); };
            process.on("SIGINT", stop);
            process.on("SIGTERM", stop);
          });
        }
        case "history": {
          const limit = fstr(flags, "limit") ? Number(fstr(flags, "limit")) : 50;
          const team = fstr(flags, "team") ?? myTeam;
          const msgs = history(store.db, { room, limit, ...(team ? { team } : {}) });
          if (flags["json"]) return out(JSON.stringify(msgs, null, 2));
          for (const m of msgs) out(`${c.dim(new Date(m.ts).toLocaleTimeString())} ${c.cyan(m.sender)}: ${m.body}`);
          return;
        }
        case "teams": {
          const teams = listTeams(store.db, room);
          if (flags["json"]) return out(JSON.stringify(teams, null, 2));
          out(teams.length ? teams.map((t) => `  ${t}`).join("\n") : c.dim("No teams yet."));
          return;
        }
        case "join": {
          const team = rest[1];
          if (!team) throw new Error("chat join requires a team name, e.g. cairn chat join frontend");
          setActiveTeam(root, actor, team);
          out(c.green(`✔ ${actor} now acting as team ${c.cyan(team)}`));
          return;
        }
        case "leave": {
          clearActiveTeam(root, actor);
          out(c.dim(`${actor} left their team`));
          return;
        }
        default:
          throw new Error("chat <verb>: send | inbox | tail | history | teams | join | leave");
      }
    } finally {
      // `tail` resolves/cleans up its own store; other verbs close here.
      if (verb !== "tail") store.close();
    }
  },
```

Note: the `tail` branch returns a Promise and manages its own `store.close()`. The `finally` guards against double-close by skipping `tail`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && npx vitest run test/chat-cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + full suite**

Run: `npx tsc --noEmit && npm test`
Expected: clean typecheck; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/cli/index.ts test/chat-cli.test.ts
git commit -m "feat(chat): cairn chat CLI (send/inbox/tail/history/teams/join/leave)"
```

---

## Task 6: MCP tools — `chat_send`, `chat_wait`, `chat_teams`

**Files:**
- Modify: `src/mcp/server.ts` (imports + three `server.tool(...)` registrations)

- [ ] **Step 1: Write the failing test**

Create `test/chat-mcp.test.ts`:

```ts
import { describe, it, expect, afterAll } from "vitest";
import { memStore, cleanupAll } from "./helpers.js";
import { sendMessage, inbox } from "../src/engines/chat.js";

afterAll(cleanupAll);

// The MCP handlers are thin wrappers over the engine; this test pins the engine
// contract the wrappers rely on (a directed send is visible to chat_wait/inbox).
describe("chat MCP contract", () => {
  it("a sent message is retrievable by the recipient", () => {
    const s = memStore("proj");
    sendMessage(s.db, { room: "proj", sender: "Claude", to: "Codex", body: "mcp ping" });
    expect(inbox(s.db, { room: "proj", actor: "Codex" }).map((m) => m.body)).toEqual(["mcp ping"]);
    s.close();
  });
});
```

(Full MCP transport wiring is integration-tested by hand; this guards the contract.)

- [ ] **Step 2: Run test to verify it fails, then passes**

Run: `npx vitest run test/chat-mcp.test.ts`
Expected: PASS immediately (engine already exists) — this is a guard test. If it fails, the engine API drifted; fix before continuing.

- [ ] **Step 3: Add the MCP tools**

In `src/mcp/server.ts`, add imports near the other engine imports (around line 6-12):

```ts
import { sendMessage, inbox, listTeams } from "../engines/chat.js";
```

Add an actor helper near `openStore` (around line 28):

```ts
function mcpActor(): string {
  return process.env["CAIRN_ACTOR"] ?? "mcp";
}
```

Register three tools alongside the others (before `await server.connect(transport)` is built — i.e. inside `createServer`, near the other `server.tool(...)` calls):

```ts
  server.tool(
    "chat_send",
    "Send a realtime chat message to other agents working in this repo. Omit " +
      "`to` to broadcast to everyone. `to` may be an agent name or a team name.",
    {
      body: z.string().describe("Message text"),
      to: z.string().optional().describe("Recipient agent or team; omit to broadcast"),
      team: z.string().optional().describe("Tag the message as belonging to this team channel"),
    },
    async ({ body, to, team }) =>
      withStore((s) =>
        json(
          sendMessage(s.db, {
            room: s.projectId,
            sender: mcpActor(),
            body,
            ...(to ? { to } : {}),
            ...(team ? { team } : {}),
          }),
        ),
      ),
  );

  server.tool(
    "chat_wait",
    "Block until a chat message addressed to this agent arrives (or the timeout " +
      "elapses), then return the new messages. Use this to receive messages live " +
      "while working. Returns an empty array on timeout.",
    {
      timeoutMs: z.number().int().optional().describe("Max time to wait (default 30000)"),
    },
    async ({ timeoutMs }) => {
      const deadline = Date.now() + (timeoutMs ?? 30000);
      // Poll the table every 1s. better-sqlite3 is synchronous; we re-open the
      // store each poll cheaply via withStore so a concurrent writer is visible.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const msgs = withStore((s) => inbox(s.db, { room: s.projectId, actor: mcpActor() }));
        if (Array.isArray(msgs) && msgs.length) return json(msgs);
        if (Date.now() >= deadline) return json([]);
        await new Promise((r) => setTimeout(r, 1000));
      }
    },
  );

  server.tool(
    "chat_teams",
    "List the team channels seen in this repo's chatroom.",
    {},
    async () => withStore((s) => json(listTeams(s.db, s.projectId))),
  );
```

Note: `withStore` returns the structured error result on failure; `chat_wait`'s `Array.isArray` guard avoids treating that error object as messages.

- [ ] **Step 4: Run test + typecheck**

Run: `npx tsc --noEmit && npx vitest run test/chat-mcp.test.ts`
Expected: clean typecheck; PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts test/chat-mcp.test.ts
git commit -m "feat(chat): MCP chat_send / chat_wait / chat_teams tools"
```

---

## Task 7: Claude Code hook wiring (monitor + turn)

**Files:**
- Modify: `src/setup/install.ts` (add a `installChatHooks` writer; call it from `setupProject`)
- Test: `test/setup.test.ts` (append idempotency case)

Read first: `src/setup/install.ts:128-184` — the existing `installSessionHook` shows the exact `.claude/settings.json` merge + marker-idempotency pattern to mirror.

- [ ] **Step 1: Write the failing test**

Append to `test/setup.test.ts` (inside the existing top-level `describe`, or a new one):

```ts
import { installChatHooks, CHAT_HOOK_MARKER } from "../src/setup/install.js";

describe("chat hooks (Claude Code)", () => {
  it("writes Stop + SessionStart chat hooks once, idempotently", () => {
    const dir = tempDir();
    setupProject(dir);
    installChatHooks(dir);
    installChatHooks(dir); // second run must not duplicate
    const settings = JSON.parse(
      readFileSync(join(dir, ".claude", "settings.json"), "utf8"),
    );
    const stop = settings.hooks.Stop as Array<{ hooks: Array<{ command: string }> }>;
    const marked = stop.flatMap((g) => g.hooks).filter((h) => h.command.includes(CHAT_HOOK_MARKER));
    expect(marked).toHaveLength(1);
    expect(marked[0]!.command).toContain("chat inbox");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/setup.test.ts -t "chat hooks"`
Expected: FAIL — `installChatHooks` / `CHAT_HOOK_MARKER` not exported.

- [ ] **Step 3: Implement `installChatHooks`**

In `src/setup/install.ts`, near `SESSION_HOOK_MARKER` (line ~131), add:

```ts
/** Marker embedded in chat hook commands so re-running setup updates in place. */
export const CHAT_HOOK_MARKER = "cairn-chat-hook";
```

Add this exported function (model it on `installSessionHook` at line ~134; reuse the same read/merge/write approach):

```ts
/**
 * Wire Claude Code chat delivery:
 *  - SessionStart: start a background `cairn chat tail` (monitor mode).
 *  - Stop: run `cairn chat inbox` between turns (turn mode) so messages that
 *    arrived mid-turn surface as soon as the agent finishes responding.
 * Idempotent via CHAT_HOOK_MARKER. Returns true if settings were written.
 */
export function installChatHooks(root: string): boolean {
  const dir = join(root, ".claude");
  const settingsPath = join(dir, "settings.json");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  let settings: any = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, "utf8")); } catch { settings = {}; }
  }
  settings.hooks = settings.hooks ?? {};

  const tailCmd = `cairn chat tail # ${CHAT_HOOK_MARKER}`;
  const inboxCmd = `cairn chat inbox # ${CHAT_HOOK_MARKER}`;

  const merge = (event: string, command: string) => {
    const list: any[] = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    const cleaned = list.filter(
      (g: any) =>
        !(Array.isArray(g?.hooks) &&
          g.hooks.some((h: any) => typeof h?.command === "string" && h.command.includes(CHAT_HOOK_MARKER))),
    );
    cleaned.push({ hooks: [{ type: "command", command }] });
    settings.hooks[event] = cleaned;
  };

  merge("Stop", inboxCmd);
  merge("SessionStart", tailCmd);

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return true;
}
```

Then call it from `setupProject` where the session hook is installed (find the existing `installSessionHook(root)` call and add directly after it):

```ts
  installChatHooks(root);
```

> If `setupProject` does not already call `installSessionHook` in a code path that has `root`, place `installChatHooks(root)` immediately after the `installSessionHook(...)` invocation so both hooks share the same lifecycle.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/setup.test.ts -t "chat hooks"`
Expected: PASS — exactly one marked Stop hook after two installs.

- [ ] **Step 5: Full suite + typecheck**

Run: `npx tsc --noEmit && npm test`
Expected: clean typecheck; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/setup/install.ts test/setup.test.ts
git commit -m "feat(chat): wire Claude Code SessionStart + Stop chat hooks"
```

---

## Task 8: Manual dogfood + docs

**Files:**
- Modify: `README.md` (or `docs/`) — document `cairn chat`.

- [ ] **Step 1: Build and link locally**

Run: `npm run build`

- [ ] **Step 2: Two-terminal smoke test**

In terminal A (in this repo): `node bin/cairn.js chat tail --actor "Claude"`
In terminal B: `node bin/cairn.js chat send --to "Claude" --body "hello from B" --actor "Codex"`
Expected: terminal A prints `Codex: hello from B` within ~2s.

- [ ] **Step 3: Team routing smoke test**

Terminal B: `node bin/cairn.js chat join frontend --actor "Codex"` then `node bin/cairn.js chat inbox --actor "Codex"`.
`node bin/cairn.js chat send --to frontend --body "navbar" --actor "Claude"`.
Terminal B `inbox`: prints `Claude: navbar`.

- [ ] **Step 4: Document**

Add a short "Agent chat" section to `README.md` listing the `cairn chat` verbs and the one-room-per-project / teams model. Note the v1 limitation: same actor name in two sessions both receive a directed message (no exclusivity lock yet).

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs(chat): document cairn chat verbs and model"
```

---

## Task 9: Record decisions + open the PR

- [ ] **Step 1: Log completion to Cairn's own journal**

```bash
node bin/cairn.js append --type knowledge.learned \
  --payload '{"statement":"Agent chatroom shipped: chat table (schema v3), cairn chat CLI, MCP chat_send/chat_wait/chat_teams, Claude Code SessionStart+Stop hooks. One room per project, teams inside. Codex/Gemini/Copilot delivery deferred to follow-on specs."}' \
  --actor "Claude Code"
```

- [ ] **Step 2: Push and open PR**

```bash
git push -u origin feat/agent-chatroom
gh pr create --title "feat: realtime agent chatroom" --body "Implements docs/superpowers/specs/2026-06-09-agent-chatroom-design.md. One room per project with teams, separate chat table (schema v3), cairn chat CLI, MCP tools, Claude Code hooks. Other tools' hooks deferred to follow-on specs.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

## Follow-on (separate specs, NOT in this plan)

- Codex hook delivery spike.
- Gemini CLI hook delivery spike.
- Copilot CLI hook delivery spike.
- Role-exclusivity locks (`actas`-style) to stop double-delivery when one actor name runs in two sessions.
