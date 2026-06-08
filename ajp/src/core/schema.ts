import type { Database } from "better-sqlite3";

/**
 * SQLite schema + migration definitions.
 *
 * The filesystem layout (`.agent/`) exists for portability; SQLite exists for
 * performance and concurrency. The schema is versioned: migrations are forward
 * functions applied in order, recorded in the `meta` table, so an old journal is
 * never broken by a newer binary.
 */

/** Current schema version this binary understands. */
export const SCHEMA_VERSION = 2;

/** A single forward migration. */
export interface Migration {
  version: number;
  description: string;
  up: (db: Database) => void;
}

/** Ordered list of migrations. Never reorder or rewrite a released migration. */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "initial journal schema (events, snapshots, meta)",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          seq        INTEGER PRIMARY KEY AUTOINCREMENT,
          id         TEXT    NOT NULL UNIQUE,
          timestamp  TEXT    NOT NULL,
          actor      TEXT    NOT NULL DEFAULT '',
          session_id TEXT    NOT NULL DEFAULT '',
          project_id TEXT    NOT NULL DEFAULT '',
          type       TEXT    NOT NULL,
          version    INTEGER NOT NULL DEFAULT 1,
          payload    TEXT    NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_events_type    ON events(type);
        CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
        CREATE INDEX IF NOT EXISTS idx_events_ts      ON events(timestamp);

        CREATE TABLE IF NOT EXISTS snapshots (
          id        TEXT    PRIMARY KEY,
          seq       INTEGER NOT NULL,
          timestamp TEXT    NOT NULL,
          state     TEXT    NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_snapshots_seq ON snapshots(seq);

        CREATE TABLE IF NOT EXISTS meta (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 2,
    description: "cold-archive table for event compaction (events forever)",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS events_archive (
          seq        INTEGER PRIMARY KEY,
          id         TEXT    NOT NULL,
          timestamp  TEXT    NOT NULL,
          actor      TEXT    NOT NULL DEFAULT '',
          session_id TEXT    NOT NULL DEFAULT '',
          project_id TEXT    NOT NULL DEFAULT '',
          type       TEXT    NOT NULL,
          version    INTEGER NOT NULL DEFAULT 1,
          payload    TEXT    NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_archive_type ON events_archive(type);
      `);
    },
  },
];

/** Read the journal's current schema version (0 if unmigrated/no meta table). */
export function currentVersion(db: Database): number {
  const hasMeta = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'")
    .get();
  if (!hasMeta) return 0;
  const row = db
    .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;
  return row ? Number(row.value) : 0;
}

/**
 * Apply all pending migrations inside a transaction, recording the new version.
 * Returns the version after migrating.
 */
export function migrate(db: Database): number {
  // The meta table must exist before we can read/write the version. The v1
  // migration creates it; for a brand-new db `currentVersion` would throw on a
  // missing table, so create meta defensively first.
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
  let from = currentVersion(db);
  const pending = MIGRATIONS.filter((m) => m.version > from).sort(
    (a, b) => a.version - b.version,
  );
  if (pending.length === 0) return from;

  const run = db.transaction(() => {
    for (const m of pending) {
      m.up(db);
      db.prepare(
        "INSERT INTO meta(key, value) VALUES('schema_version', ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(String(m.version));
      from = m.version;
    }
  });
  run();
  return from;
}
