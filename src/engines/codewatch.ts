import { watch as fsWatch, existsSync, statSync, readFileSync, type FSWatcher } from "node:fs";
import { join, sep } from "node:path";
import type { EventStore } from "../core/store.js";
import { listSourceFiles, indexOneEvent } from "./codegraph.js";

/**
 * Live code-graph watcher — keep the STATIC map fresh on every save, not just on
 * commit. Structure (imports/exports) updates as you type; intent (commit
 * message → co-occurrence) still belongs to commits. So cold-start relevance
 * never goes stale between commits, including uncommitted work-in-progress.
 *
 * Cheap and safe by design:
 *   - debounced per file (re-index only after edits settle), so a burst of saves
 *     collapses to one parse;
 *   - skips files that look mid-edit (unbalanced brackets / open strings) —
 *     never records a broken half-typed module;
 *   - idempotent (content-hash event id) — an unchanged file is a no-op;
 *   - JS/TS only (where the parser lives); other languages are ignored here and
 *     picked up by `sync` on commit.
 *
 * No new dependencies — `fs.watch` with `recursive` (Node ≥ 20 on macOS/Win/Linux).
 */

const JS_TS = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const SKIP = /(^|\/)(node_modules|dist|build|out|coverage|\.git|vendor|\.agent)(\/|$)/;

export interface WatchHandle {
  close(): void;
  /** Counters, for the CLI to report. */
  stats: { reindexed: number; skipped: number; recorded: number };
}

export interface WatchOptions {
  debounceMs?: number;
  actor?: string;
  /** Called after each successful re-index (path + whether it changed the graph). */
  onIndex?: (path: string, recorded: boolean) => void;
  /** Called when a save is skipped because the file looks mid-edit. */
  onSkip?: (path: string) => void;
}

/**
 * Start watching `root` for source edits. Returns a handle whose `close()` stops
 * the watcher. The caller owns `store` (kept open for the watcher's lifetime).
 */
export function watchCode(store: EventStore, root: string, opts: WatchOptions = {}): WatchHandle {
  const debounceMs = opts.debounceMs ?? 2500;
  const actor = opts.actor ?? "cairn-watch";
  const stats = { reindexed: 0, skipped: 0, recorded: 0 };

  // The set of resolvable repo files (for import resolution). Seeded once; a
  // never-before-seen path triggers a cheap refresh so new files resolve.
  let known = new Set(listSourceFiles(root));

  const timers = new Map<string, NodeJS.Timeout>();

  const flush = (rel: string): void => {
    timers.delete(rel);
    const abs = join(root, rel);
    if (!existsSync(abs)) return; // deleted before flush — sync/commit handles removal
    let content = "";
    try {
      if (!statSync(abs).isFile()) return;
      content = readFileSync(abs, "utf8");
    } catch {
      return;
    }
    if (!known.has(rel)) { known = new Set(listSourceFiles(root)); } // new file appeared
    const ev = indexOneEvent(rel, known, content, actor);
    if (!ev) { stats.skipped++; opts.onSkip?.(rel); return; } // looked mid-edit
    stats.reindexed++;
    const before = store.count();
    store.appendEvent(ev);
    const recorded = store.count() > before; // false ⇒ unchanged (id deduped)
    if (recorded) stats.recorded++;
    opts.onIndex?.(rel, recorded);
  };

  const onChange = (_event: string, filename: string | Buffer | null): void => {
    if (!filename) return;
    const rel = (typeof filename === "string" ? filename : filename.toString()).split(sep).join("/");
    if (SKIP.test(rel) || !JS_TS.test(rel)) return;
    const t = timers.get(rel);
    if (t) clearTimeout(t);
    timers.set(rel, setTimeout(() => flush(rel), debounceMs));
  };

  let watcher: FSWatcher;
  try {
    watcher = fsWatch(root, { recursive: true }, onChange);
  } catch (e) {
    throw new Error(`code watcher could not start (recursive fs.watch unsupported?): ${(e as Error).message}`);
  }

  return {
    stats,
    close() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      watcher.close();
    },
  };
}
