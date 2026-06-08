import type { Agent, AgentStatus, AgentType } from "./types.js";
import { readJson, writeJson } from "./io.js";
import { statedPaths } from "./paths.js";
import { nowIso } from "./ids.js";
import { appendEvent } from "./events.js";
import { regenerate } from "./snapshot.js";

/** Agents considered "active" if seen within this window (ms). 15 minutes. */
export const ACTIVE_WINDOW_MS = 15 * 60 * 1000;

/** Read all registered agents from `.stated/agents.json`. */
export function readAgents(root: string): Agent[] {
  return readJson<Agent[]>(statedPaths(root).agents, []);
}

/** Overwrite the agents list. */
export function writeAgents(root: string, agents: Agent[]): void {
  writeJson(statedPaths(root).agents, agents);
}

/** Infer an {@link AgentType} from a free-form name. */
export function inferAgentType(name: string): AgentType {
  const n = name.toLowerCase();
  if (n.includes("claude")) return "claude";
  if (n.includes("codex") || n.includes("gpt") || n.includes("openai")) {
    return "codex";
  }
  if (n.includes("cursor")) return "cursor";
  if (n.includes("openhands") || n.includes("devin")) return "openhands";
  if (n.includes("human") || n.includes("dev")) return "human";
  return "other";
}

/**
 * Register an agent (idempotent). Re-registering an existing agent simply
 * refreshes its `lastSeen` and marks it active.
 */
export function registerAgent(
  root: string,
  name: string,
  type?: AgentType,
): Agent {
  const clean = name.trim();
  if (!clean) throw new Error("Agent name cannot be empty.");
  const agents = readAgents(root);
  const now = nowIso();
  let agent = agents.find((a) => a.name === clean);
  if (agent) {
    agent.status = "active";
    agent.lastSeen = now;
    if (type) agent.type = type;
  } else {
    agent = {
      name: clean,
      type: type ?? inferAgentType(clean),
      status: "active",
      lastSeen: now,
    };
    agents.push(agent);
  }
  writeAgents(root, agents);
  appendEvent(root, "agent_registered", {
    actor: clean,
    data: { name: clean, type: agent.type },
  });
  regenerate(root);
  return agent;
}

/** Touch an agent's `lastSeen` (a lightweight heartbeat). No-op if unknown. */
export function touchAgent(root: string, name: string): void {
  const clean = name.trim();
  if (!clean) return;
  const agents = readAgents(root);
  const agent = agents.find((a) => a.name === clean);
  if (!agent) return;
  agent.lastSeen = nowIso();
  agent.status = "active";
  writeAgents(root, agents);
  appendEvent(root, "agent_seen", { actor: clean });
}

/** Compute a fresh {@link AgentStatus} from an agent's `lastSeen`. */
export function liveStatus(agent: Agent, nowMs = Date.now()): AgentStatus {
  if (agent.status === "offline") return "offline";
  const seen = Date.parse(agent.lastSeen);
  if (Number.isNaN(seen)) return agent.status;
  return nowMs - seen <= ACTIVE_WINDOW_MS ? "active" : "idle";
}

/** Agents seen recently enough to be considered active. */
export function activeAgents(root: string, nowMs = Date.now()): Agent[] {
  return readAgents(root)
    .map((a) => ({ ...a, status: liveStatus(a, nowMs) }))
    .filter((a) => a.status === "active");
}
