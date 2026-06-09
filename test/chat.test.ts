import { describe, it, expect, afterAll } from "vitest";
import { memStore, cleanupAll, tempDir } from "./helpers.js";
import { sendMessage, inbox } from "../src/engines/chat.js";
import { history, listTeams } from "../src/engines/chat.js";
import { setActiveTeam, getActiveTeam, clearActiveTeam } from "../src/engines/chat-membership.js";

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
    expect(inbox(s.db, { room: "p", actor: "Codex", team: "frontend" }).map((m) => m.body))
      .toEqual(["ship the navbar"]);
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
