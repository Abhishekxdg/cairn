// Concurrency worker: append N events to a shared journal db, then exit.
// Usage: node append-worker.mjs <dbPath> <actor> <count>
import { EventStore } from "../dist/core/store.js";

const [dbPath, actor, countStr] = process.argv.slice(2);
const count = Number(countStr);
const store = new EventStore(dbPath, { projectId: "concurrency" });

for (let i = 0; i < count; i++) {
  store.appendEvent({
    type: "custom.ping",
    actor,
    payload: { i },
  });
}
store.close();
process.exit(0);
