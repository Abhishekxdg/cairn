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
