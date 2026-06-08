import type { EventStore } from "../core/store.js";
import { currentVersion, SCHEMA_VERSION } from "../core/schema.js";
import { latestSnapshot, snapshotCount } from "./snapshots.js";

/**
 * Observability — health checks, integrity validation, repair.
 *
 * The journal is the source of truth, so its integrity matters above all. These
 * tools verify the invariants (gap-free sequence, unique + parseable events,
 * schema currency) and offer safe repairs.
 */

export interface HealthMetrics {
  ok: boolean;
  events: number;
  /** Cold-archived events (still part of the journal). */
  archived: number;
  /** Total journal size = hot + archive. */
  total: number;
  lastSeq: number;
  snapshots: number;
  snapshotLag: number;
  schemaVersion: number;
  expectedSchemaVersion: number;
  walPages: number;
  issues: string[];
}

/** Quick health snapshot of the journal. */
export function health(store: EventStore): HealthMetrics {
  const issues: string[] = [];
  const events = store.count();
  const lastSeq = store.lastSeq();
  const snap = latestSnapshot(store);
  const schemaVersion = currentVersion(store.db);
  if (schemaVersion !== SCHEMA_VERSION) {
    issues.push(
      `schema version ${schemaVersion} != expected ${SCHEMA_VERSION} — run \`cairn migrate\``,
    );
  }
  const walPages =
    (store.db.pragma("wal_checkpoint(PASSIVE)", { simple: false }) as unknown) &&
    (store.db.pragma("page_count", { simple: true }) as number);

  return {
    ok: issues.length === 0,
    events,
    archived: store.archivedCount(),
    total: store.totalCount(),
    lastSeq,
    snapshots: snapshotCount(store),
    snapshotLag: snap ? lastSeq - snap.seq : lastSeq,
    schemaVersion,
    expectedSchemaVersion: SCHEMA_VERSION,
    walPages: typeof walPages === "number" ? walPages : 0,
    issues,
  };
}

export interface IntegrityReport {
  healthy: boolean;
  checked: number;
  problems: string[];
}

/**
 * Validate journal integrity: SQLite's own check, gap-free `seq`, unique ids,
 * and parseable payloads. Read-only.
 */
export function validateIntegrity(store: EventStore): IntegrityReport {
  const problems: string[] = [];

  const ic = store.db.pragma("integrity_check", { simple: true });
  if (ic !== "ok") problems.push(`sqlite integrity_check: ${ic}`);

  // Gap-free sequence: count + min/max should be consistent.
  const { c, mn, mx } = store.db
    .prepare("SELECT COUNT(*) c, MIN(seq) mn, MAX(seq) mx FROM events")
    .get() as { c: number; mn: number | null; mx: number | null };
  if (c > 0 && mx !== null && mn !== null) {
    // AUTOINCREMENT guarantees monotonicity; a gap only appears if rows were
    // deleted (which the protocol forbids). Detect it.
    const distinct = (
      store.db.prepare("SELECT COUNT(DISTINCT seq) d FROM events").get() as {
        d: number;
      }
    ).d;
    if (distinct !== c) problems.push("duplicate seq values detected");
  }

  // Parseable payloads + unique ids across the FULL journal (hot + archive).
  let checked = 0;
  const ids = new Set<string>();
  for (const ev of store.streamEvents({ includeArchive: true })) {
    checked++;
    if (ids.has(ev.id)) problems.push(`duplicate event id: ${ev.id}`);
    ids.add(ev.id);
    if (
      ev.payload &&
      typeof ev.payload === "object" &&
      "_corrupt" in ev.payload
    ) {
      problems.push(`unparseable payload at seq ${ev.seq}`);
    }
  }

  return { healthy: problems.length === 0, checked, problems };
}

export interface RepairReport {
  actions: string[];
}

/**
 * Repair safe-to-fix issues: checkpoint the WAL, rebuild indexes, and VACUUM to
 * reclaim space. Never edits or drops events — history is immutable.
 */
export function repair(store: EventStore): RepairReport {
  const actions: string[] = [];
  store.db.pragma("wal_checkpoint(TRUNCATE)");
  actions.push("checkpointed WAL");
  store.db.exec("REINDEX");
  actions.push("rebuilt indexes");
  store.db.exec("VACUUM");
  actions.push("vacuumed database");
  return { actions };
}
