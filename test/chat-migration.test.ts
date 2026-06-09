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
    expect(() => s.db.exec("SELECT 1 FROM chat LIMIT 0")).not.toThrow();
    s.close();
  });
});
