import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

/**
 * Lightweight "is there a newer cairn?" check. Pings the npm registry at most
 * once per day (result cached on disk), compares to the running version, and
 * lets the CLI print a one-line nudge. Entirely best-effort and non-blocking:
 * no network, no cache, or a parse error all degrade to "no notification".
 */

const PKG = "@memxai/cairn";
const TTL_MS = 24 * 60 * 60 * 1000; // check at most once/day
const FETCH_TIMEOUT_MS = 2000;

interface Cache {
  checkedAt: number;
  latest: string;
}

function cacheFile(): string {
  return join(homedir() || ".", ".cache", "cairn", "update.json");
}

/** Compare two `x.y.z` versions. Returns true when `a` is strictly newer. */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) =>
    v
      .replace(/^v/, "")
      .split("-")[0]! // drop any prerelease suffix
      .split(".")
      .map((n) => Number(n) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

function readCache(): Cache | null {
  try {
    const raw = readFileSync(cacheFile(), "utf8");
    const c = JSON.parse(raw) as Cache;
    if (typeof c.checkedAt === "number" && typeof c.latest === "string") return c;
  } catch {
    /* no cache yet */
  }
  return null;
}

function writeCache(c: Cache): void {
  try {
    mkdirSync(dirname(cacheFile()), { recursive: true });
    writeFileSync(cacheFile(), JSON.stringify(c));
  } catch {
    /* cache is an optimization; ignore failures */
  }
}

/** Fetch the latest published version from the npm registry, or null. */
async function fetchLatest(): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(
        `https://registry.npmjs.org/${PKG}/latest`,
        { signal: ctrl.signal, headers: { accept: "application/json" } },
      );
      if (!res.ok) return null;
      const body = (await res.json()) as { version?: string };
      return typeof body.version === "string" ? body.version : null;
    } finally {
      clearTimeout(t);
    }
  } catch {
    return null;
  }
}

/**
 * Return the latest known version (from cache, or a fresh fetch when the cache
 * is stale). `now` is injectable for tests. Never throws.
 */
export async function latestVersion(now = Date.now()): Promise<string | null> {
  const cached = readCache();
  if (cached && now - cached.checkedAt < TTL_MS) return cached.latest;
  const latest = await fetchLatest();
  if (latest) writeCache({ checkedAt: now, latest });
  return latest ?? cached?.latest ?? null;
}

/**
 * Print an update nudge to stderr if a newer version exists. Skipped for
 * non-interactive output, CI, and when the user opts out with
 * CAIRN_NO_UPDATE_CHECK=1. Awaited but bounded by a 2s fetch timeout.
 */
export async function notifyIfUpdate(current: string): Promise<void> {
  if (
    process.env["CAIRN_NO_UPDATE_CHECK"] === "1" ||
    process.env["CI"] ||
    !process.stderr.isTTY
  ) {
    return;
  }
  const latest = await latestVersion();
  if (latest && isNewer(latest, current)) {
    process.stderr.write(
      `\n[2m↑ cairn ${latest} available (you have ${current}). ` +
        `Update: npm i -g @memxai/cairn  ·  or run: cairn upgrade[0m\n`,
    );
  }
}
