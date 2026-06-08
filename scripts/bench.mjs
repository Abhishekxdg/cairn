#!/usr/bin/env node
// 10M-scale benchmark for Cairn. Not part of the test run (it takes a while).
//
//   npm run build && node scripts/bench.mjs [count]   # default 10_000_000
//
// Reports: append throughput, db size, cold-start (open + derive), context
// generation, and peak RSS — the numbers behind the README's performance table.

import { mkdtempSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStore } from "../dist/core/store.js";
import { deriveState } from "../dist/engines/state.js";
import { compileContext } from "../dist/engines/context.js";
import { createSnapshot } from "../dist/engines/snapshots.js";
import { compactJournal } from "../dist/engines/compaction.js";

const COUNT = Number(process.argv[2] ?? 10_000_000);
const dir = mkdtempSync(join(tmpdir(), "cairn-bench-"));
const dbPath = join(dir, "journal.db");
const mb = (n) => (n / 1e6).toFixed(1);

console.log(`Cairn benchmark — ${COUNT.toLocaleString()} events\n`);

// --- Append throughput (batched) --------------------------------------------
let store = new EventStore(dbPath, { projectId: "bench" });
const BATCH = 10_000;
const t0 = process.hrtime.bigint();
for (let i = 0; i < COUNT; i += BATCH) {
  const n = Math.min(BATCH, COUNT - i);
  const batch = new Array(n);
  for (let k = 0; k < n; k++) {
    const j = i + k;
    batch[k] = j % 5 === 0
      ? { type: "task.created", payload: { id: `t${j}`, title: `Task ${j}` } }
      : { type: "file.modified", payload: { path: `src/f${j % 1000}.ts` }, actor: "A" };
  }
  store.batchAppend(batch);
  if (i % 1_000_000 === 0 && i > 0) process.stdout.write(`  …${(i / 1e6)}M\n`);
}
const appendSec = Number(process.hrtime.bigint() - t0) / 1e9;
console.log(`Append:   ${(COUNT / appendSec / 1e6).toFixed(2)}M events/s (${appendSec.toFixed(1)}s total, ~${(appendSec / COUNT * 1000).toFixed(4)}ms/event)`);

// Snapshot + compact so cold start uses the fast path and the hot table stays small.
createSnapshot(store, deriveState(store, { fromScratch: true }));
const comp = compactJournal(store, { keepRecent: 1000 });
console.log(`Compact:  archived ${comp.archived.toLocaleString()}, hot table now ${comp.remaining.toLocaleString()}`);
store.close();

console.log(`DB size:  ${mb(statSync(dbPath).size)} MB`);

// --- Cold start: open + derive ----------------------------------------------
const c0 = process.hrtime.bigint();
store = new EventStore(dbPath, {});
const state = deriveState(store);
const coldMs = Number(process.hrtime.bigint() - c0) / 1e6;
console.log(`Cold start (open + derive): ${coldMs.toFixed(1)}ms  (${state.tasks.length.toLocaleString()} tasks)`);

// --- Context generation ------------------------------------------------------
const x0 = process.hrtime.bigint();
compileContext(store, { level: "medium", state });
console.log(`Context:  ${(Number(process.hrtime.bigint() - x0) / 1e6).toFixed(1)}ms`);

console.log(`Peak RSS: ${mb(process.memoryUsage().rss)} MB`);
store.close();
rmSync(dir, { recursive: true, force: true });
