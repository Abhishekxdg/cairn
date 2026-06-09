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
