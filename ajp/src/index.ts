/**
 * Agent Journal Protocol (AJP) — the Git of AI memory.
 *
 * A universal, local-first, event-sourced memory protocol for AI agents.
 * History is truth; state is a cache; snapshots are an optimization.
 *
 * ```ts
 * import { AgentJournal } from "agent-journal-protocol";
 * const journal = new AgentJournal({ actor: "Claude Code" });
 * await journal.registerAgent();
 * const ctx = journal.getContext("small");
 * ```
 */

export { AgentJournal, createJournal } from "./sdk/index.js";

// Core protocol surface.
export * from "./core/types.js";
export { EventStore } from "./core/store.js";
export * from "./core/paths.js";
export * from "./core/manifest.js";
export { SCHEMA_VERSION, MIGRATIONS, migrate, currentVersion } from "./core/schema.js";
export { ulid, shortId, nowIso, dateOf } from "./core/ids.js";

// Reducers + engines.
export * from "./reducers/index.js";
export * from "./engines/state.js";
export * from "./engines/snapshots.js";
export * from "./engines/context.js";
export * from "./engines/timeline.js";
export * from "./engines/memory.js";
export * from "./engines/observability.js";
export * from "./engines/git.js";
export * from "./engines/agents.js";
export * from "./engines/compaction.js";
export * from "./setup/install.js";
export * from "./setup/global.js";
export { RULES_BODY, rulesBlock, GLOBAL_RULES_BODY, globalRulesBlock } from "./setup/rules.js";

/** Package version. */
export const VERSION = "0.1.0";
