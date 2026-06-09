import { describe, it, expect, afterAll } from "vitest";
import { memStore, cleanupAll } from "./helpers.js";
import { sendMessage, inbox } from "../src/engines/chat.js";

afterAll(cleanupAll);

describe("chat MCP contract", () => {
  it("a sent message is retrievable by the recipient", () => {
    const s = memStore("proj");
    sendMessage(s.db, { room: "proj", sender: "Claude", to: "Codex", body: "mcp ping" });
    expect(inbox(s.db, { room: "proj", actor: "Codex" }).map((m) => m.body)).toEqual(["mcp ping"]);
    s.close();
  });
});
