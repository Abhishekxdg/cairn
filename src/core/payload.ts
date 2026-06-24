/**
 * Type-safe coercion helpers for extracting typed values from untyped event
 * payloads (`Record<string, unknown>`). Used by reducers, engines, and anywhere
 * else that reads raw payload fields.
 */

/** Coerce an unknown value to a string, returning `fallback` if not a string. */
export function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

/** Coerce an unknown value to a finite number, returning `fallback` otherwise. */
export function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Coerce an unknown value to a string array, filtering out non-strings. */
export function arr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
