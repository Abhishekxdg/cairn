import { describe, it, expect, afterAll } from "vitest";
import Database from "better-sqlite3";
import { fileStore, tempDir, cleanupAll } from "./helpers.js";
import { join } from "node:path";
import { EventStore } from "../src/core/store.js";
import { migrate, currentVersion, SCHEMA_VERSION } from "../src/core/schema.js";
import { validateIntegrity, health, repair } from "../src/engines/observability.js";

afterAll(cleanupAll);

describe("migrations", () => {
  it("migrates a blank database to the current version", () => {
    const dir = tempDir();
    const db = new Database(join(dir, "blank.db"));
    expect(currentVersion(db)).toBe(0);
    const v = migrate(db);
    expect(v).toBe(SCHEMA_VERSION);
    expect(currentVersion(db)).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("is idempotent (re-running applies nothing)", () => {
    const dir = tempDir();
    const db = new Database(join(dir, "x.db"));
    migrate(db);
    const before = currentVersion(db);
    expect(migrate(db)).toBe(before);
    db.close();
  });

  it("opening a store runs migrations and is healthy", () => {
    const { store } = fileStore();
    store.appendEvent({ type: "custom.a" });
    const h = health(store);
    expect(h.schemaVersion).toBe(SCHEMA_VERSION);
    expect(h.ok).toBe(true);
    store.close();
  });
});

describe("observability", () => {
  it("validateIntegrity passes on a clean journal", () => {
    const { store } = fileStore();
    for (let i = 0; i < 20; i++) store.appendEvent({ type: "custom.n", payload: { i } });
    const r = validateIntegrity(store);
    expect(r.healthy).toBe(true);
    expect(r.checked).toBe(20);
    store.close();
  });

  it("repair runs without touching events", () => {
    const { store } = fileStore();
    store.appendEvent({ type: "custom.a" });
    store.appendEvent({ type: "custom.b" });
    const r = repair(store);
    expect(r.actions.length).toBeGreaterThan(0);
    expect(store.count()).toBe(2);
    store.close();
  });
});
