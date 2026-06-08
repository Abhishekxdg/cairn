/**
 * Agent Journal Protocol — core types.
 *
 * The journal is an append-only stream of immutable events. EVERYTHING else
 * (state, tasks, decisions, memory, context) is *derived* from these events.
 * History is truth; state is a cache; snapshots are an optimization.
 */

/**
 * Canonical event type identifiers. The protocol is open: any string of the
 * form `custom.*` (or, in practice, any namespaced string) is also valid, which
 * is why {@link EventType} is `KnownEventType | (string & {})` — known types get
 * autocomplete while the stream stays extensible for the next decade.
 */
export type KnownEventType =
  | "agent.registered"
  | "agent.heartbeat"
  | "agent.disconnected"
  | "goal.created"
  | "goal.updated"
  | "goal.archived"
  | "task.created"
  | "task.started"
  | "task.blocked"
  | "task.completed"
  | "task.archived"
  | "decision.made"
  | "decision.superseded"
  | "decision.reverted"
  | "decision.archived"
  | "file.read"
  | "file.created"
  | "file.modified"
  | "file.deleted"
  | "git.commit"
  | "artifact.created"
  | "artifact.updated"
  | "artifact.deleted"
  | "knowledge.learned"
  | "knowledge.invalidated"
  | "memory.recorded"
  | "memory.archived"
  | "context.generated"
  | "message.sent"
  | "message.received"
  | "snapshot.created"
  | "session.started"
  | "session.ended";

/** An event type: a known type, or any custom/extension string. */
export type EventType = KnownEventType | (string & {});

/** Arbitrary structured event payload. */
export type Payload = Record<string, unknown>;

/**
 * An immutable journal event. Once appended it is never edited or deleted.
 * `seq` is assigned by the store (monotonic, gap-free per database) and gives a
 * total order; `id` is a globally-unique, time-sortable identifier used for
 * idempotency.
 */
export interface JournalEvent<P extends Payload = Payload> {
  /** Monotonic sequence number assigned on append (total order). */
  seq: number;
  /** Globally-unique, lexicographically time-sortable id (ULID). */
  id: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Who produced the event (agent or human name). */
  actor: string;
  /** Session/run scope this event belongs to. */
  sessionId: string;
  /** Project scope (matches the manifest's projectId). */
  projectId: string;
  /** Event type discriminant. */
  type: EventType;
  /** Schema version of the payload for this event type. */
  version: number;
  /** Structured event data. */
  payload: P;
}

/** The fields a caller provides when appending; the store fills the rest. */
export interface NewEvent<P extends Payload = Payload> {
  type: EventType;
  payload?: P;
  /** Optional explicit id (enables client-side idempotency). */
  id?: string;
  actor?: string;
  sessionId?: string;
  /** Optional explicit timestamp (defaults to now). */
  timestamp?: string;
  /** Payload schema version (defaults to 1). */
  version?: number;
}

/** Filter for {@link EventStore.queryEvents}. */
export interface EventQuery {
  /** Only events of these types. */
  types?: EventType[];
  /** Only events from this session. */
  sessionId?: string;
  /** Only events by this actor. */
  actor?: string;
  /** Events with `seq > sinceSeq`. */
  sinceSeq?: number;
  /** Events with `seq <= untilSeq`. */
  untilSeq?: number;
  /** Events at/after this ISO timestamp. */
  since?: string;
  /** Events at/before this ISO timestamp. */
  until?: string;
  /** Max rows. */
  limit?: number;
  /** Sort order by seq. Default "asc". */
  order?: "asc" | "desc";
}

// --- Derived domain types ----------------------------------------------------

export type TaskStatus = "todo" | "active" | "blocked" | "completed" | "archived";
export type TaskPriority = "low" | "medium" | "high" | "critical";

/** A task, derived by folding `task.*` events. */
export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  owner: string;
  priority: TaskPriority;
  dependencies: string[];
  blockers: string[];
  createdBy: string;
  completedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export type DecisionStatus = "active" | "superseded" | "reverted" | "archived";

/** A decision, derived by folding `decision.*` events. */
export interface Decision {
  id: string;
  title: string;
  rationale: string;
  status: DecisionStatus;
  madeBy: string;
  /** The decision id that superseded this one, if any. */
  supersededBy: string | null;
  /** The decision id this one supersedes, if any. */
  supersedes: string | null;
  createdAt: string;
  updatedAt: string;
}

export type GoalStatus = "active" | "archived";

/** A goal, derived by folding `goal.*` events. */
export interface Goal {
  id: string;
  title: string;
  description: string;
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
}

export type AgentLiveness = "active" | "idle" | "offline";

/** A registered agent, derived by folding `agent.*` events. */
export interface AgentRecord {
  name: string;
  type: string;
  version: string;
  capabilities: string[];
  currentSession: string;
  lastSeen: string;
  /** Computed at read time from `lastSeen`. */
  liveness: AgentLiveness;
}

/** File ownership, derived from `file.*` events (last writer owns). */
export interface Ownership {
  path: string;
  owner: string;
  lastSeq: number;
  updatedAt: string;
}

/** A piece of learned knowledge, derived from `knowledge.*` events. */
export interface Knowledge {
  id: string;
  statement: string;
  source: string;
  valid: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * The full derived state of a project — a pure fold over the event stream.
 * Never edited by hand; always reconstructable from events.
 */
export interface DerivedState {
  projectId: string;
  /** Sequence number of the last event folded into this state. */
  lastSeq: number;
  goals: Goal[];
  tasks: Task[];
  decisions: Decision[];
  agents: AgentRecord[];
  ownership: Ownership[];
  knowledge: Knowledge[];
  generatedAt: string;
}

/** Project manifest stored at `.agent/manifest.json`. */
export interface Manifest {
  protocol: "agent-journal-protocol";
  /** Journal/schema format version. */
  schemaVersion: number;
  projectId: string;
  name: string;
  createdAt: string;
}
