import { describe, it, expect, afterAll } from "vitest";
import { memStore, cleanupAll } from "./helpers.js";

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

  it("applies column defaults — read_by defaults to '[]', nullable cols to null", () => {
    const s = memStore();
    s.db
      .prepare("INSERT INTO chat (id, room, sender, body, ts) VALUES (?, ?, ?, ?, ?)")
      .run("m1", "proj", "Claude", "hello", 1000);
    const row = s.db.prepare("SELECT * FROM chat WHERE id = 'm1'").get() as Record<string, unknown>;
    s.close();
    expect(row.read_by).toBe("[]");
    expect(row.team).toBeNull();
    expect(row.recipient).toBeNull();
    expect(row.body).toBe("hello");
  });
});
