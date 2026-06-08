import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Low-level, synchronous, Git-friendly file IO.
 *
 * All writes are atomic (write to a temp file in the same directory, fsync,
 * then rename) so a crashed or concurrent process can never leave a half-written
 * state file behind. JSON is pretty-printed with a trailing newline to minimize
 * merge conflicts and keep diffs readable.
 */

/** Read a UTF-8 text file, returning `fallback` if it does not exist. */
export function readText(path: string, fallback = ""): string {
  if (!existsSync(path)) return fallback;
  return readFileSync(path, "utf8");
}

/** Atomically write a UTF-8 text file, creating parent dirs as needed. */
export function writeText(path: string, content: string): void {
  ensureDir(dirname(path));
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/** Read and parse a JSON file, returning `fallback` when missing or empty. */
export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(
      `Corrupt JSON in ${path}: ${(err as Error).message}. ` +
        "Fix the file by hand or restore from .stated/snapshots/.",
    );
  }
}

/** Atomically write a value as pretty-printed JSON with a trailing newline. */
export function writeJson(path: string, value: unknown): void {
  writeText(path, JSON.stringify(value, null, 2) + "\n");
}

/** Append a single line to a file, creating it (and parents) if needed. */
export function appendLine(path: string, line: string): void {
  ensureDir(dirname(path));
  const fd = openSync(path, "a");
  try {
    writeSync(fd, line.endsWith("\n") ? line : line + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Read a `.jsonl` file into an array of parsed records, skipping blank lines. */
export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // A single malformed line should not break the whole stream.
      continue;
    }
  }
  return out;
}

/** Create a directory (recursively) if it does not already exist. */
export function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

/** Whether a path exists. */
export function exists(path: string): boolean {
  return existsSync(path);
}

/** Force-flush a directory entry to disk (best effort). */
export function syncDir(path: string): void {
  try {
    const fd = openSync(path, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Directory fsync is not supported on every platform; ignore failures.
  }
}

/** Re-export for callers that want a quick existence check on a written file. */
export { writeFileSync };
