import { EventStore } from "../core/store.js";
import { agentPaths, requireRoot, findRoot, isInitialized } from "../core/paths.js";
import { init as coreInit, readManifest, type InitOptions } from "../core/manifest.js";
import { shortId, ulid, nowIso } from "../core/ids.js";
import type {
  JournalEvent,
  NewEvent,
  EventQuery,
  EventType,
  Payload,
  DerivedState,
  Task,
  Decision,
} from "../core/types.js";
import { deriveState } from "../engines/state.js";
import {
  compileContext,
  type CompiledContext,
  type ContextLevel,
} from "../engines/context.js";
import {
  deriveTimeline,
  deriveMemory,
  deriveKnowledge,
} from "../engines/memory.js";
import { renderTimeline, type TimelineDay } from "../engines/timeline.js";
import {
  createSnapshot,
  snapshotDue,
  type SnapshotPolicy,
  DEFAULT_SNAPSHOT_POLICY,
} from "../engines/snapshots.js";
import {
  health,
  validateIntegrity,
  repair,
  type HealthMetrics,
  type IntegrityReport,
  type RepairReport,
} from "../engines/observability.js";
import { detectGit, gitCorrelation, type GitInfo } from "../engines/git.js";
import { pruneAgents, staleAgents, type PruneReport } from "../engines/agents.js";
import { compactJournal, type CompactionReport } from "../engines/compaction.js";
import { syncGit, type GitSyncResult } from "../engines/gitsync.js";
import { writeContextFile } from "../engines/recall.js";

/**
 * AgentJournal — the high-level TypeScript SDK.
 *
 * One instance is one session. Every `append` is attributed to the configured
 * actor + session, auto-snapshots when the policy is due, and is fully
 * derivable later. All reads (`getState`, `getContext`, `getTimeline`,
 * `getMemory`) are projections over the same immutable journal.
 *
 * ```ts
 * const journal = new AgentJournal({ actor: "Claude Code" });
 * await journal.registerAgent();
 * const task = await journal.createTask({ title: "Build OAuth" });
 * await journal.completeTask(task);
 * const ctx = await journal.getContext("small");
 * ```
 */
export class AgentJournal {
  private readonly cwd: string;
  private readonly dbPath: string | undefined;
  private readonly policy: SnapshotPolicy;
  private store: EventStore | null = null;

  /** Actor name stamped on appended events. */
  readonly actor: string;
  /** Session id stamped on appended events. */
  readonly sessionId: string;

  constructor(
    opts: {
      cwd?: string;
      actor?: string;
      sessionId?: string;
      dbPath?: string;
      projectId?: string;
      snapshotPolicy?: SnapshotPolicy;
      autoGit?: boolean;
    } = {},
  ) {
    this.cwd = opts.cwd ?? process.cwd();
    this.actor = opts.actor ?? "unknown";
    this.sessionId = opts.sessionId ?? shortId("sess");
    this.dbPath = opts.dbPath;
    this.policy = opts.snapshotPolicy ?? DEFAULT_SNAPSHOT_POLICY;
    this.autoGit = opts.autoGit ?? true;
    this.explicitProjectId = opts.projectId;
  }

  private readonly autoGit: boolean;
  private readonly explicitProjectId: string | undefined;

  /** Initialize a `.agent/` journal in the cwd. */
  static init(cwd: string = process.cwd(), opts: InitOptions = {}) {
    return coreInit(cwd, opts);
  }

  /** Whether a journal exists at or above the cwd. */
  isInitialized(): boolean {
    return this.dbPath ? true : isInitialized(this.cwd);
  }

  /** Resolve the project root (throws if uninitialized, unless using dbPath). */
  get root(): string {
    return requireRoot(this.cwd);
  }

  /** Lazily open (and cache) the event store. */
  get db(): EventStore {
    if (!this.store) {
      if (this.dbPath) {
        this.store = new EventStore(this.dbPath, {
          ...(this.explicitProjectId ? { projectId: this.explicitProjectId } : {}),
        });
      } else {
        const paths = agentPaths(this.root);
        this.store = new EventStore(paths.db);
      }
    }
    return this.store;
  }

  /** Close the underlying database. */
  close(): void {
    this.store?.close();
    this.store = null;
  }

  // --- Append ----------------------------------------------------------------

  /** Append a raw event. Auto-attributes actor/session and snapshots if due. */
  appendEvent<P extends Payload = Payload>(
    input: NewEvent<P>,
  ): JournalEvent<P> {
    const enriched: NewEvent<P> = {
      ...input,
      actor: input.actor ?? this.actor,
      sessionId: input.sessionId ?? this.sessionId,
    };
    if (this.autoGit && !this.dbPath) {
      const corr = gitCorrelation(this.root);
      if (Object.keys(corr).length) {
        enriched.payload = { ...(input.payload ?? {}), ...corr } as P;
      }
    }
    const ev = this.db.appendEvent(enriched);
    this.maybeSnapshot();
    return ev;
  }

  /** Sugar over {@link appendEvent}. */
  append<P extends Payload = Payload>(
    type: EventType,
    payload?: P,
    opts: Omit<NewEvent<P>, "type" | "payload"> = {},
  ): JournalEvent<P> {
    return this.appendEvent<P>({ type, ...(payload ? { payload } : {}), ...opts });
  }

  /** Append many events atomically. */
  batchAppend(inputs: NewEvent[]): JournalEvent[] {
    const enriched = inputs.map((i) => ({
      ...i,
      actor: i.actor ?? this.actor,
      sessionId: i.sessionId ?? this.sessionId,
    }));
    const events = this.db.batchAppend(enriched);
    this.maybeSnapshot();
    return events;
  }

  private maybeSnapshot(): void {
    if (snapshotDue(this.db, this.policy)) {
      createSnapshot(this.db, deriveState(this.db));
    }
    // Keep the instant-recall file current after every state change. Never let
    // a recall-write failure break an append.
    try {
      writeContextFile(this.db, this.dbPath ? this.cwd : this.root);
    } catch {
      /* recall file is best-effort */
    }
  }

  // --- Query / derive --------------------------------------------------------

  /** Query raw events. */
  events(query: EventQuery = {}): JournalEvent[] {
    return this.db.queryEvents(query);
  }

  /** Export the full journal. */
  exportEvents(): JournalEvent[] {
    return this.db.exportEvents();
  }

  /** Derive current state. */
  getState(opts: { fromScratch?: boolean } = {}): DerivedState {
    return deriveState(this.db, opts);
  }

  /** Compile minimum-token context at a level. */
  getContext(level: ContextLevel = "medium"): CompiledContext {
    const ctx = compileContext(this.db, { level });
    // Record that context was generated (observability / replay completeness).
    this.db.appendEvent({
      type: "context.generated",
      actor: this.actor,
      sessionId: this.sessionId,
      payload: { level, asOfSeq: ctx.asOfSeq },
    });
    return ctx;
  }

  /** Derive a day-grouped timeline. */
  getTimeline(opts: { sinceSeq?: number; types?: string[] } = {}): TimelineDay[] {
    return deriveTimeline(this.db, opts);
  }

  /** Render the timeline to human-readable text. */
  renderTimeline(opts: { sinceSeq?: number; types?: string[] } = {}): string {
    return renderTimeline(this.getTimeline(opts));
  }

  /** Derive recorded memories. */
  getMemory() {
    return deriveMemory(this.db);
  }

  /** Derive currently-valid knowledge. */
  getKnowledge(opts: { includeInvalid?: boolean } = {}) {
    return deriveKnowledge(this.db, opts);
  }

  // --- Snapshots / ops -------------------------------------------------------

  /** Force a snapshot now and return its sequence. */
  snapshot(): number {
    const snap = createSnapshot(this.db, deriveState(this.db));
    this.db.appendEvent({
      type: "snapshot.created",
      actor: this.actor,
      sessionId: this.sessionId,
      payload: { seq: snap.seq, snapshotId: snap.id },
    });
    return snap.seq;
  }

  /** Prune stale agents (records `agent.disconnected`). */
  prune(opts: { idleMs?: number } = {}): PruneReport {
    return pruneAgents(this.db, { ...opts, actor: this.actor });
  }
  /** Agents currently considered stale (read-only). */
  staleAgents(opts: { idleMs?: number } = {}) {
    return staleAgents(this.db, opts);
  }
  /** Cold-archive old events behind a snapshot to keep the hot table small. */
  compactJournal(opts: { keepRecent?: number } = {}): CompactionReport {
    return compactJournal(this.db, opts);
  }

  /**
   * Auto-capture file events from git history (zero agent effort). Idempotent;
   * typically wired to a git post-commit hook by `ajp setup`.
   */
  sync(opts: { full?: boolean } = {}): GitSyncResult {
    const root = this.dbPath ? this.cwd : this.root;
    const res = syncGit(this.db, root, opts);
    try {
      writeContextFile(this.db, root);
    } catch {
      /* best-effort */
    }
    return res;
  }

  /** The instant-recall context (also persisted to `.agent/CONTEXT.md`). */
  recall() {
    return writeContextFile(this.db, this.dbPath ? this.cwd : this.root);
  }

  health(): HealthMetrics {
    return health(this.db);
  }
  validate(): IntegrityReport {
    return validateIntegrity(this.db);
  }
  repair(): RepairReport {
    return repair(this.db);
  }
  compact() {
    return this.db.compact();
  }
  git(): GitInfo {
    return detectGit(this.dbPath ? this.cwd : this.root);
  }
  manifest() {
    return readManifest(this.root);
  }

  // --- Convenience emitters --------------------------------------------------

  registerAgent(
    name: string = this.actor,
    opts: { type?: string; version?: string; capabilities?: string[] } = {},
  ): JournalEvent {
    return this.append("agent.registered", {
      name,
      ...(opts.type ? { type: opts.type } : {}),
      ...(opts.version ? { version: opts.version } : {}),
      ...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
      session: this.sessionId,
    });
  }

  heartbeat(name: string = this.actor): JournalEvent {
    return this.append("agent.heartbeat", { name, session: this.sessionId });
  }

  createGoal(input: { title: string; description?: string; id?: string }) {
    const id = input.id ?? shortId("goal");
    this.append("goal.created", {
      id,
      title: input.title,
      ...(input.description ? { description: input.description } : {}),
    });
    return id;
  }

  createTask(input: {
    title: string;
    description?: string;
    priority?: Task["priority"];
    owner?: string;
    dependencies?: string[];
    id?: string;
  }): { id: string } {
    const id = input.id ?? shortId("task");
    this.append("task.created", {
      id,
      title: input.title,
      ...(input.description ? { description: input.description } : {}),
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.owner ? { owner: input.owner } : {}),
      ...(input.dependencies ? { dependencies: input.dependencies } : {}),
      createdBy: this.actor,
    });
    return { id };
  }

  startTask(task: string | { id: string }, owner?: string) {
    return this.append("task.started", {
      id: typeof task === "string" ? task : task.id,
      ...(owner ? { owner } : {}),
    });
  }
  blockTask(task: string | { id: string }, reason?: string) {
    return this.append("task.blocked", {
      id: typeof task === "string" ? task : task.id,
      ...(reason ? { reason } : {}),
    });
  }
  completeTask(task: string | { id: string }) {
    return this.append("task.completed", {
      id: typeof task === "string" ? task : task.id,
      completedBy: this.actor,
    });
  }

  decide(input: {
    title: string;
    rationale?: string;
    supersedes?: string;
    id?: string;
  }): { id: string } {
    const id = input.id ?? shortId("dec");
    this.append("decision.made", {
      id,
      title: input.title,
      ...(input.rationale ? { rationale: input.rationale } : {}),
      ...(input.supersedes ? { supersedes: input.supersedes } : {}),
      madeBy: this.actor,
    });
    return { id };
  }
  revertDecision(id: string) {
    return this.append("decision.reverted", { id });
  }

  learn(statement: string, source?: string): { id: string } {
    const id = shortId("kn");
    this.append("knowledge.learned", {
      id,
      statement,
      ...(source ? { source } : {}),
    });
    return { id };
  }

  recordMemory(content: string, tags: string[] = []): { id: string } {
    const id = shortId("mem");
    this.append("memory.recorded", { id, content, tags });
    return { id };
  }

  fileTouched(path: string, kind: "created" | "modified" | "deleted" = "modified") {
    return this.append(`file.${kind}`, { path, owner: this.actor });
  }
}

/** Factory mirroring `new AgentJournal(opts)`. */
export function createJournal(
  opts?: ConstructorParameters<typeof AgentJournal>[0],
): AgentJournal {
  return new AgentJournal(opts);
}

export { ulid, nowIso };
