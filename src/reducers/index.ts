import type {
  JournalEvent,
  DerivedState,
  Task,
  Decision,
  Goal,
  AgentRecord,
  Ownership,
  Knowledge,
  TaskPriority,
} from "../core/types.js";
import { nowIso } from "../core/ids.js";
import { str, num, arr } from "../core/payload.js";

/**
 * Reducers — pure folds from events to derived state.
 *
 * Determinism is the contract: replaying the same events always yields the same
 * state. That is why derived-entity ids come from the event payload or the event
 * id (never freshly generated), and why nothing here reads the clock except to
 * stamp `generatedAt`.
 */

/** A mutable accumulator using maps for O(1) lookups during a fold. */
class Builder {
  goals = new Map<string, Goal>();
  tasks = new Map<string, Task>();
  decisions = new Map<string, Decision>();
  agents = new Map<string, AgentRecord>();
  ownership = new Map<string, Ownership>();
  knowledge = new Map<string, Knowledge>();
  lastSeq = 0;
  constructor(public projectId: string) {}

  materialize(): DerivedState {
    return {
      projectId: this.projectId,
      lastSeq: this.lastSeq,
      goals: [...this.goals.values()],
      tasks: [...this.tasks.values()],
      decisions: [...this.decisions.values()],
      agents: [...this.agents.values()],
      ownership: [...this.ownership.values()],
      knowledge: [...this.knowledge.values()],
      generatedAt: nowIso(),
    };
  }
}


/** Derived-entity id: explicit payload id, else the deterministic event id. */
function entityId(ev: JournalEvent): string {
  return str(ev.payload["id"], ev.id);
}

function applyEvent(b: Builder, ev: JournalEvent): void {
  b.lastSeq = ev.seq;
  const p = ev.payload;
  const at = ev.timestamp;

  switch (ev.type) {
    // --- Goals ---------------------------------------------------------------
    case "goal.created": {
      const id = entityId(ev);
      b.goals.set(id, {
        id,
        title: str(p["title"]),
        description: str(p["description"]),
        status: "active",
        createdAt: at,
        updatedAt: at,
      });
      break;
    }
    case "goal.updated": {
      const g = b.goals.get(str(p["id"]));
      if (g) {
        if (typeof p["title"] === "string") g.title = p["title"];
        if (typeof p["description"] === "string") g.description = p["description"];
        g.updatedAt = at;
      }
      break;
    }
    case "goal.archived": {
      const g = b.goals.get(str(p["id"]));
      if (g) {
        g.status = "archived";
        g.updatedAt = at;
      }
      break;
    }

    // --- Tasks ---------------------------------------------------------------
    case "task.created": {
      const id = entityId(ev);
      b.tasks.set(id, {
        id,
        title: str(p["title"]),
        description: str(p["description"]),
        status: "todo",
        owner: str(p["owner"]),
        priority: (str(p["priority"], "medium") as TaskPriority),
        dependencies: arr(p["dependencies"]),
        blockers: [],
        createdBy: str(p["createdBy"], ev.actor),
        completedBy: null,
        createdAt: at,
        updatedAt: at,
      });
      break;
    }
    case "task.started": {
      const t = b.tasks.get(str(p["id"]));
      if (t) {
        t.status = "active";
        if (typeof p["owner"] === "string") t.owner = p["owner"];
        else if (!t.owner && ev.actor) t.owner = ev.actor;
        t.updatedAt = at;
      }
      break;
    }
    case "task.blocked": {
      const t = b.tasks.get(str(p["id"]));
      if (t) {
        t.status = "blocked";
        const blocker = str(p["blocker"] ?? p["reason"]);
        if (blocker && !t.blockers.includes(blocker)) t.blockers.push(blocker);
        t.updatedAt = at;
      }
      break;
    }
    case "task.completed": {
      const t = b.tasks.get(str(p["id"]));
      if (t) {
        t.status = "completed";
        t.completedBy = str(p["completedBy"], ev.actor);
        t.updatedAt = at;
      }
      break;
    }
    case "task.archived": {
      const t = b.tasks.get(str(p["id"]));
      if (t) {
        t.status = "archived";
        t.updatedAt = at;
      }
      break;
    }

    // --- Decisions -----------------------------------------------------------
    case "decision.made": {
      const id = entityId(ev);
      const supersedes = str(p["supersedes"]) || null;
      b.decisions.set(id, {
        id,
        title: str(p["title"]),
        rationale: str(p["rationale"] ?? p["reason"]),
        status: "active",
        madeBy: str(p["madeBy"], ev.actor),
        supersededBy: null,
        supersedes,
        anchor: p["anchor"] === true,
        weight: num(p["weight"]),
        createdAt: at,
        updatedAt: at,
      });
      if (supersedes) {
        const old = b.decisions.get(supersedes);
        if (old) {
          old.status = "superseded";
          old.supersededBy = id;
          old.updatedAt = at;
        }
      }
      break;
    }
    case "decision.superseded": {
      const old = b.decisions.get(str(p["id"]));
      if (old) {
        old.status = "superseded";
        old.supersededBy = str(p["by"]) || old.supersededBy;
        old.updatedAt = at;
      }
      break;
    }
    case "decision.reverted": {
      const d = b.decisions.get(str(p["id"]));
      if (d) {
        d.status = "reverted";
        d.updatedAt = at;
      }
      break;
    }
    case "decision.archived": {
      const d = b.decisions.get(str(p["id"]));
      if (d) {
        d.status = "archived";
        d.updatedAt = at;
      }
      break;
    }

    // --- Agents --------------------------------------------------------------
    case "agent.registered": {
      const name = str(p["name"], ev.actor);
      if (!name) break;
      b.agents.set(name, {
        name,
        type: str(p["type"], inferType(name)),
        version: str(p["version"]),
        capabilities: arr(p["capabilities"]),
        currentSession: str(p["session"] ?? ev.sessionId),
        lastSeen: at,
        liveness: "active",
      });
      break;
    }
    case "agent.heartbeat": {
      const name = str(p["name"], ev.actor);
      const a = b.agents.get(name);
      if (a) {
        a.lastSeen = at;
        if (p["session"]) a.currentSession = str(p["session"]);
      }
      break;
    }
    case "agent.disconnected": {
      const a = b.agents.get(str(p["name"], ev.actor));
      if (a) a.liveness = "offline";
      break;
    }

    // --- Files / ownership ---------------------------------------------------
    case "file.created":
    case "file.modified": {
      const path = str(p["path"]);
      if (!path) break;
      b.ownership.set(path, {
        path,
        owner: str(p["owner"], ev.actor),
        lastSeq: ev.seq,
        updatedAt: at,
      });
      break;
    }
    case "file.deleted": {
      b.ownership.delete(str(p["path"]));
      break;
    }

    // --- Knowledge -----------------------------------------------------------
    case "knowledge.learned": {
      const id = entityId(ev);
      b.knowledge.set(id, {
        id,
        statement: str(p["statement"] ?? p["text"]),
        source: str(p["source"], ev.actor),
        valid: true,
        anchor: p["anchor"] === true || p["durable"] === true,
        weight: num(p["weight"]),
        createdAt: at,
        updatedAt: at,
      });
      break;
    }
    case "knowledge.invalidated": {
      const k = b.knowledge.get(str(p["id"]));
      if (k) {
        k.valid = false;
        k.updatedAt = at;
      }
      break;
    }

    // file.read, message.*, memory.*, context.generated, session.*, snapshot.*,
    // custom.* — recorded in history but do not change derived state here.
    default:
      break;
  }
}

function inferType(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("claude")) return "claude";
  if (n.includes("codex") || n.includes("gpt")) return "codex";
  if (n.includes("cursor")) return "cursor";
  if (n.includes("openhands") || n.includes("devin")) return "openhands";
  if (n.includes("human")) return "human";
  return "other";
}

/** Window (ms) within which an agent's last heartbeat counts as active. */
export const AGENT_ACTIVE_WINDOW_MS = 15 * 60 * 1000;

/** Compute agent liveness from `lastSeen` relative to `now`. */
export function agentLiveness(
  a: AgentRecord,
  now: number,
): AgentRecord["liveness"] {
  if (a.liveness === "offline") return "offline";
  const seen = Date.parse(a.lastSeen);
  if (Number.isNaN(seen)) return a.liveness;
  return now - seen <= AGENT_ACTIVE_WINDOW_MS ? "active" : "idle";
}

/** A single-event reducer compatible with {@link EventStore.replayEvents}. */
export function createReducer(
  projectId: string,
): {
  reducer: (b: Builder, ev: JournalEvent) => Builder;
  initial: Builder;
} {
  const initial = new Builder(projectId);
  return {
    initial,
    reducer: (b, ev) => {
      applyEvent(b, ev);
      return b;
    },
  };
}

/** Rehydrate a {@link Builder} from a previously materialized state (snapshot). */
export function builderFromState(state: DerivedState): Builder {
  const b = new Builder(state.projectId);
  b.lastSeq = state.lastSeq;
  for (const g of state.goals) b.goals.set(g.id, { ...g });
  for (const t of state.tasks) b.tasks.set(t.id, { ...t });
  for (const d of state.decisions) b.decisions.set(d.id, { ...d });
  for (const a of state.agents) b.agents.set(a.name, { ...a });
  for (const o of state.ownership) b.ownership.set(o.path, { ...o });
  for (const k of state.knowledge) b.knowledge.set(k.id, { ...k });
  return b;
}

/** Fold a list of events into a {@link DerivedState}. */
export function foldState(
  events: Iterable<JournalEvent>,
  projectId: string,
  now: number = Date.now(),
): DerivedState {
  const b = new Builder(projectId);
  for (const ev of events) applyEvent(b, ev);
  const state = b.materialize();
  for (const a of state.agents) a.liveness = agentLiveness(a, now);
  return state;
}

export { Builder, applyEvent };
