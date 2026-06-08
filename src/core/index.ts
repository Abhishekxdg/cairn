/**
 * Stated core — the canonical, synchronous, file-backed API.
 *
 * Everything in `core/` operates directly on a `.stated/` directory on disk.
 * The CLI, SDK and MCP server are all thin layers over these functions.
 */

export * from "./types.js";
export * from "./paths.js";
export {
  readText,
  writeText,
  readJson,
  writeJson,
  readJsonl,
  appendLine,
} from "./io.js";
export { taskId, decisionId, nowIso, today } from "./ids.js";

export * from "./events.js";
export * from "./config.js";
export * from "./staleness.js";
export * from "./decay.js";
export * from "./framework.js";
export * from "./project.js";
export * from "./goals.js";
export * from "./tasks.js";
export * from "./decisions.js";
export * from "./agents.js";
export * from "./files.js";
export * from "./search.js";
export * from "./sync.js";
export * from "./snapshot.js";
export * from "./init.js";
export * from "./doctor.js";
