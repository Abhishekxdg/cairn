import { randomUUID } from "node:crypto";

/**
 * Short, URL-safe, human-typable identifiers.
 *
 * Task ids look like `t_a1b2c3d4`. They are short enough to type on the CLI
 * (`stated task claim t_a1b2c3d4`) but carry enough entropy (32 bits) to avoid
 * collisions in any realistic project. Decisions use the `d_` prefix.
 */

function shortId(): string {
  // Take the first 8 hex chars of a v4 UUID — 32 bits of entropy.
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

/** Generate a new task id, e.g. `t_a1b2c3d4`. */
export function taskId(): string {
  return `t_${shortId()}`;
}

/** Generate a new decision id, e.g. `d_a1b2c3d4`. */
export function decisionId(): string {
  return `d_${shortId()}`;
}

/** Current time as an ISO-8601 string. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Current calendar date as `YYYY-MM-DD`. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
