import Database from "better-sqlite3";
import type { Database as DB, Statement } from "better-sqlite3";
import { mkdirSync, existsSync, appendFileSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  JournalEvent,
  NewEvent,
  EventQuery,
  Payload,
} from "./types.js";
import { ulid, nowIso } from "./ids.js";
import { migrate } from "./schema.js";

/**
 * The event store — the append-only, concurrency-safe heart of the protocol.
 *
 * Backed by SQLite in WAL mode. Appends are single-row INSERTs inside the
 * engine's own locking, so there is no read-modify-write race: many processes
 * (Claude Code, Codex, Cursor, OpenHands) can append concurrently and SQLite
 * serializes writers while allowing concurrent readers. `seq` (AUTOINCREMENT)
 * gives a gap-free total order; `id` (ULID, UNIQUE) gives idempotency.
 */
export class EventStore {
  readonly db: DB;
  private readonly insertStmt: Statement;
  private readonly byIdStmt: Statement;
  /**
   * Path to the committed, merge-friendly `events.jsonl` — the portable SOURCE
   * OF TRUTH. The SQLite db is a fast, git-ignored cache rebuilt from it.
   * `null` for in-memory/readonly stores (no mirror).
   */
  private readonly jsonlPath: string | null;

  constructor(
    dbPath: string,
    opts: { projectId?: string; readonly?: boolean } = {},
  ) {
    if (dbPath !== ":memory:" && !existsSync(dirname(dbPath))) {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath, { readonly: opts.readonly ?? false });
    this.jsonlPath =
      dbPath === ":memory:" || opts.readonly
        ? null
        : join(dirname(dbPath), "events.jsonl");
    if (!opts.readonly) {
      // Durability + concurrency tuning. WAL allows one writer + many readers;
      // busy_timeout makes concurrent writers wait rather than fail; NORMAL
      // sync is the WAL-recommended balance of safety and speed.
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = NORMAL");
      this.db.pragma("busy_timeout = 5000");
      this.db.pragma("foreign_keys = ON");
      migrate(this.db);
    }
    this.projectId = opts.projectId ?? this.readProjectId();
    this.insertStmt = this.db.prepare(
      `INSERT OR IGNORE INTO events
         (id, timestamp, actor, session_id, project_id, type, version, payload)
       VALUES (@id, @timestamp, @actor, @sessionId, @projectId, @type, @version, @payload)`,
    );
    this.byIdStmt = this.db.prepare("SELECT * FROM events WHERE id = ?");
    if (!opts.readonly) this.reconcileJsonl();
  }

  /** Insert a fully-formed event row with an explicit seq (used by rehydrate). */
  private insertWithSeq(e: JournalEvent): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO events
           (seq, id, timestamp, actor, session_id, project_id, type, version, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.seq,
        e.id,
        e.timestamp,
        e.actor,
        e.sessionId,
        e.projectId,
        e.type,
        e.version,
        JSON.stringify(e.payload ?? {}),
      );
  }

  /** Append one event line to the committed `events.jsonl` mirror. */
  private mirror(e: JournalEvent): void {
    if (!this.jsonlPath) return;
    appendFileSync(this.jsonlPath, JSON.stringify(e) + "\n");
  }

  /** Load events from raw jsonl lines into the hot table (INSERT OR IGNORE). */
  private rebuildHotFromLines(lines: string[]): void {
    const tx = this.db.transaction(() => {
      for (const line of lines) {
        try {
          this.insertWithSeq(JSON.parse(line) as JournalEvent);
        } catch {
          /* skip a corrupt line */
        }
      }
    });
    tx();
  }

  /**
   * Reconcile the SQLite cache with the committed `events.jsonl` source of truth.
   * The jsonl is authoritative; the db is a rebuildable cache. Cases:
   * - db empty            → rebuild the cache from jsonl (fresh clone).
   * - jsonl ahead of db   → load the missing events into the cache (merged-in
   *                         history, or a crash that dropped a db write).
   * - db ahead of jsonl   → restore jsonl from the durable db (legacy/pre-jsonl
   *                         db, or a crash that dropped the last jsonl append).
   * - equal but divergent → trust the committed log; rebuild the cache.
   *
   * When events have been cold-archived, archived rows live only in SQLite, so a
   * line-vs-row catch-up would resurrect them — fall back to the conservative
   * "only materialize jsonl when the db is strictly ahead" rule.
   */
  private reconcileJsonl(): void {
    if (!this.jsonlPath) return;
    const dbCount = this.totalCount(); // hot + cold-archived
    const lines = existsSync(this.jsonlPath)
      ? readFileSync(this.jsonlPath, "utf8").split("\n").filter((l) => l.trim())
      : [];

    if (dbCount === 0) {
      if (lines.length > 0) this.rebuildHotFromLines(lines);
      return;
    }

    const materializeJsonl = () => {
      const all = this.queryEvents({});
      writeFileSync(this.jsonlPath!, all.map((e) => JSON.stringify(e)).join("\n") + "\n");
    };

    // Compaction in play: line-based catch-up is unsafe (would un-archive rows).
    if (this.archivedCount() > 0) {
      if (dbCount > lines.length) materializeJsonl();
      return;
    }

    // No archive: dbCount == hot table size.
    if (lines.length > dbCount) {
      // jsonl ahead → catch the cache up (only missing events are inserted).
      this.rebuildHotFromLines(lines);
      return;
    }
    if (dbCount > lines.length) {
      materializeJsonl(); // db ahead → restore the committed log from it.
      return;
    }

    // Equal length: detect equal-but-divergent (e.g. a bad merge kept the count)
    // by comparing the tail event's identity. If they disagree, the committed
    // log wins and the cache is rebuilt from it.
    if (lines.length === 0) return;
    let lastLineId: string | undefined;
    try {
      lastLineId = (JSON.parse(lines[lines.length - 1]!) as JournalEvent).id;
    } catch {
      return; // corrupt tail line — leave both for `cairn repair`.
    }
    const dbLastId = (
      this.db.prepare("SELECT id FROM events ORDER BY seq DESC LIMIT 1").get() as
        | { id: string }
        | undefined
    )?.id;
    if (lastLineId && dbLastId && lastLineId !== dbLastId) {
      this.db.exec("DELETE FROM events");
      this.rebuildHotFromLines(lines);
    }
  }

  /** Project id stamped onto appended events. */
  projectId: string;

  private readProjectId(): string {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = 'project_id'")
      .get() as { value: string } | undefined;
    return row?.value ?? "";
  }

  /** Persist a key in the journal's meta table. */
  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO meta(key, value) VALUES(?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  /** Read a meta key. */
  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  /**
   * Append a single event. Idempotent on `id`: appending an event whose id
   * already exists is a no-op and returns the existing row. Atomic and
   * concurrency-safe.
   */
  appendEvent<P extends Payload = Payload>(
    input: NewEvent<P>,
  ): JournalEvent<P> {
    const row = {
      id: input.id ?? ulid(),
      timestamp: input.timestamp ?? nowIso(),
      actor: input.actor ?? "",
      sessionId: input.sessionId ?? "",
      projectId: this.projectId,
      type: input.type,
      version: input.version ?? 1,
      payload: JSON.stringify(input.payload ?? {}),
    };
    const info = this.insertStmt.run(row);
    if (info.changes === 0) {
      // Duplicate id — return the already-stored event (idempotency).
      return this.hydrate(this.byIdStmt.get(row.id) as RawRow) as JournalEvent<P>;
    }
    const event: JournalEvent<P> = {
      seq: Number(info.lastInsertRowid),
      id: row.id,
      timestamp: row.timestamp,
      actor: row.actor,
      sessionId: row.sessionId,
      projectId: row.projectId,
      type: row.type,
      version: row.version,
      payload: (input.payload ?? {}) as P,
    };
    // Mirror to the committed source-of-truth log (only real, new events).
    this.mirror(event);
    return event;
  }

  /**
   * Append many events atomically in a single transaction. Either all
   * non-duplicate events are written or none are. Returns the written events.
   */
  batchAppend(inputs: NewEvent[]): JournalEvent[] {
    const tx = this.db.transaction((items: NewEvent[]) => {
      const out: JournalEvent[] = [];
      for (const it of items) out.push(this.appendEvent(it));
      return out;
    });
    return tx(inputs);
  }

  /** Fetch a single event by id. */
  getById(id: string): JournalEvent | undefined {
    const raw = this.byIdStmt.get(id) as RawRow | undefined;
    return raw ? this.hydrate(raw) : undefined;
  }

  /** The highest sequence number currently in the journal (0 if empty). */
  lastSeq(): number {
    const row = this.db.prepare("SELECT MAX(seq) AS m FROM events").get() as {
      m: number | null;
    };
    return row.m ?? 0;
  }

  /** Count of events in the hot table. */
  count(): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }
    ).c;
  }

  /** Count of cold-archived events. */
  archivedCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM events_archive")
      .get() as { c: number } | undefined;
    return row?.c ?? 0;
  }

  /** Total events across hot + archive — the full journal size. */
  totalCount(): number {
    return this.count() + this.archivedCount();
  }

  /**
   * Cold-archive every event with `seq <= beforeSeq`: copy it into
   * `events_archive`, then remove it from the hot `events` table. Events are NOT
   * lost — the archive is part of the journal and remains queryable/exportable;
   * this only shrinks the hot working set so the table stays fast at 10M+ scale.
   * `seq` is never reused (AUTOINCREMENT), so the total order is preserved.
   *
   * CALLER CONTRACT: a snapshot covering `beforeSeq` must exist, or full
   * cold-path replay would be unable to reconstruct intermediate state. Use the
   * {@link compactJournal} engine helper, which enforces this.
   */
  compactEvents(beforeSeq: number): { archived: number; remaining: number } {
    const tx = this.db.transaction((cut: number) => {
      const copy = this.db.prepare(
        `INSERT OR IGNORE INTO events_archive
           (seq, id, timestamp, actor, session_id, project_id, type, version, payload)
         SELECT seq, id, timestamp, actor, session_id, project_id, type, version, payload
         FROM events WHERE seq <= ?`,
      );
      const moved = copy.run(cut).changes;
      this.db.prepare("DELETE FROM events WHERE seq <= ?").run(cut);
      return moved;
    });
    const archived = tx(beforeSeq) as number;
    return { archived, remaining: this.count() };
  }

  /** Query events with a structured filter. */
  queryEvents(q: EventQuery = {}): JournalEvent[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.types?.length) {
      where.push(`type IN (${q.types.map(() => "?").join(",")})`);
      params.push(...q.types);
    }
    if (q.sessionId) {
      where.push("session_id = ?");
      params.push(q.sessionId);
    }
    if (q.actor) {
      where.push("actor = ?");
      params.push(q.actor);
    }
    if (q.sinceSeq !== undefined) {
      where.push("seq > ?");
      params.push(q.sinceSeq);
    }
    if (q.untilSeq !== undefined) {
      where.push("seq <= ?");
      params.push(q.untilSeq);
    }
    if (q.since) {
      where.push("timestamp >= ?");
      params.push(q.since);
    }
    if (q.until) {
      where.push("timestamp <= ?");
      params.push(q.until);
    }
    const sql =
      "SELECT * FROM events" +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      ` ORDER BY seq ${q.order === "desc" ? "DESC" : "ASC"}` +
      (q.limit ? ` LIMIT ${Math.max(0, Math.floor(q.limit))}` : "");
    return (this.db.prepare(sql).all(...params) as RawRow[]).map((r) =>
      this.hydrate(r),
    );
  }

  /**
   * Stream events in seq order as a generator, paging through the database so
   * memory stays flat even across millions of events. With `includeArchive`,
   * cold-archived events are streamed first (they have lower seq), giving a
   * complete, correctly-ordered history for full replay.
   */
  *streamEvents(
    opts: { sinceSeq?: number; batchSize?: number; includeArchive?: boolean } = {},
  ): Generator<JournalEvent> {
    const batchSize = opts.batchSize ?? 1000;
    const start = opts.sinceSeq ?? 0;

    if (opts.includeArchive && this.archivedCount() > 0) {
      yield* this.pageTable("events_archive", start, batchSize);
    }
    yield* this.pageTable("events", start, batchSize);
  }

  private *pageTable(
    table: "events" | "events_archive",
    start: number,
    batchSize: number,
  ): Generator<JournalEvent> {
    let cursor = start;
    const stmt = this.db.prepare(
      `SELECT * FROM ${table} WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
    );
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const rows = stmt.all(cursor, batchSize) as RawRow[];
      if (rows.length === 0) return;
      for (const r of rows) {
        cursor = r.seq;
        yield this.hydrate(r);
      }
      if (rows.length < batchSize) return;
    }
  }

  /**
   * Replay the journal through a reducer, returning the folded result. This is
   * the canonical way to rebuild any derived view from history.
   */
  replayEvents<S>(
    reducer: (state: S, event: JournalEvent) => S,
    initial: S,
    opts: { sinceSeq?: number; includeArchive?: boolean } = {},
  ): S {
    let state = initial;
    for (const ev of this.streamEvents(opts)) state = reducer(state, ev);
    return state;
  }

  /**
   * Compact the journal: events are forever, but ones older than a retained
   * snapshot can be moved out of the hot table. Here compaction VACUUMs and
   * checkpoints the WAL to reclaim space without dropping history. Returns the
   * page count before/after.
   */
  compact(): { before: number; after: number } {
    const before = (
      this.db.pragma("page_count", { simple: true }) as number
    );
    this.db.pragma("wal_checkpoint(TRUNCATE)");
    this.db.exec("VACUUM");
    const after = this.db.pragma("page_count", { simple: true }) as number;
    return { before, after };
  }

  /**
   * Export the full journal (hot + cold archive) as events in seq order — the
   * complete, portable history for backup or cross-implementation interop.
   */
  exportEvents(): JournalEvent[] {
    return [...this.streamEvents({ includeArchive: true })];
  }

  /** Close the database handle. */
  close(): void {
    this.db.close();
  }

  private hydrate(r: RawRow): JournalEvent {
    return {
      seq: r.seq,
      id: r.id,
      timestamp: r.timestamp,
      actor: r.actor,
      sessionId: r.session_id,
      projectId: r.project_id,
      type: r.type,
      version: r.version,
      payload: safeParse(r.payload),
    };
  }
}

interface RawRow {
  seq: number;
  id: string;
  timestamp: string;
  actor: string;
  session_id: string;
  project_id: string;
  type: string;
  version: number;
  payload: string;
}

function safeParse(s: string): Payload {
  try {
    return JSON.parse(s) as Payload;
  } catch {
    return { _corrupt: s };
  }
}
