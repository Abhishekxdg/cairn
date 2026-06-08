/**
 * Stated — shared state layer for AI coding agents.
 *
 * Public entry point. Re-exports the high-level SDK and the full synchronous
 * core API so consumers can pick whichever altitude they need:
 *
 * ```ts
 * import { Stated } from "stated";        // ergonomic async SDK
 * import { buildState, addTask } from "stated"; // low-level core functions
 * ```
 */

export { Stated, createStated } from "./sdk/index.js";
export type { StatedOptions } from "./sdk/index.js";

export * from "./core/index.js";

/** Package version, kept in sync with package.json by the build. */
export const VERSION = "0.1.0";
