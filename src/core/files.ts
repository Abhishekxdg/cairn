import type { FileOwnership } from "./types.js";
import { readJson, writeJson } from "./io.js";
import { statedPaths } from "./paths.js";
import { nowIso } from "./ids.js";
import { appendEvent } from "./events.js";
import { regenerate } from "./snapshot.js";

/**
 * File ownership / soft locks (`.stated/files.json`).
 *
 * A "lock" here is advisory — it does not touch the filesystem. Its job is to
 * let agents coordinate: before editing `src/payment.ts`, an agent claims it,
 * and other agents reading the shared state see it is owned and avoid a
 * conflicting edit.
 */

/** Normalize a path to forward slashes so records are Git/OS portable. */
export function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Read all file-ownership records. */
export function readFiles(root: string): FileOwnership[] {
  return readJson<FileOwnership[]>(statedPaths(root).files, []);
}

/** Overwrite the file-ownership list. */
export function writeFiles(root: string, files: FileOwnership[]): void {
  writeJson(statedPaths(root).files, files);
}

/** Look up the ownership record for a path, if any. */
export function fileOwner(root: string, path: string): FileOwnership | undefined {
  const p = normalizePath(path);
  return readFiles(root).find((f) => f.path === p);
}

/** Locked files only. */
export function lockedFiles(root: string): FileOwnership[] {
  return readFiles(root).filter((f) => f.locked);
}

/**
 * Claim a file for an owner. Refuses to take a file locked by a different owner
 * unless `force` is set.
 */
export function claimFile(
  root: string,
  path: string,
  owner: string,
  opts: { lock?: boolean; force?: boolean } = {},
): FileOwnership {
  const p = normalizePath(path);
  const o = owner.trim();
  if (!p) throw new Error("File path cannot be empty.");
  if (!o) throw new Error("Claiming a file requires an owner.");

  const files = readFiles(root);
  const existing = files.find((f) => f.path === p);
  if (existing && existing.locked && existing.owner !== o && !opts.force) {
    throw new Error(
      `File ${p} is locked by "${existing.owner}". Pass force to override.`,
    );
  }

  const now = nowIso();
  const record: FileOwnership = {
    path: p,
    owner: o,
    locked: opts.lock ?? true,
    claimedAt: now,
    lastVerifiedAt: now,
  };
  if (existing) {
    Object.assign(existing, record);
  } else {
    files.push(record);
  }
  writeFiles(root, files);
  appendEvent(root, "file_claimed", {
    actor: o,
    data: { path: p, owner: o, locked: record.locked },
  });
  regenerate(root);
  return record;
}

/**
 * Re-confirm a file claim is still active without re-claiming. Refreshes
 * `lastVerifiedAt` so the lock's staleness clock resets.
 */
export function verifyFile(
  root: string,
  path: string,
  actor?: string,
): FileOwnership {
  const p = normalizePath(path);
  const files = readFiles(root);
  const record = files.find((f) => f.path === p);
  if (!record) throw new Error(`No claim on "${p}".`);
  record.lastVerifiedAt = nowIso();
  writeFiles(root, files);
  appendEvent(root, "memory_verified", {
    ...(actor ? { actor } : {}),
    data: { kind: "file", path: p },
  });
  regenerate(root);
  return record;
}

/**
 * Release a file. Refuses to release another owner's lock unless `force`.
 * Returns `true` if a record was removed.
 */
export function releaseFile(
  root: string,
  path: string,
  opts: { owner?: string; force?: boolean } = {},
): boolean {
  const p = normalizePath(path);
  const files = readFiles(root);
  const idx = files.findIndex((f) => f.path === p);
  if (idx === -1) return false;
  const record = files[idx]!;
  if (
    opts.owner &&
    record.owner !== opts.owner &&
    record.locked &&
    !opts.force
  ) {
    throw new Error(
      `File ${p} is owned by "${record.owner}", not "${opts.owner}". ` +
        "Pass force to override.",
    );
  }
  files.splice(idx, 1);
  writeFiles(root, files);
  appendEvent(root, "file_released", {
    ...(opts.owner ? { actor: opts.owner } : {}),
    data: { path: p },
  });
  regenerate(root);
  return true;
}
