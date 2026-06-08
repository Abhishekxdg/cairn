// Runnable SDK example.
//
//   npm run build && node examples/sdk-usage.mjs
//
// Simulates two agents (Claude Code and Codex) collaborating on one project
// through the shared `.stated/` brain — no cloud, no models, just files.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Stated } from "../dist/index.js";

const dir = mkdtempSync(join(tmpdir(), "stated-example-"));
console.log("Project:", dir);

// --- Claude Code starts the project ----------------------------------------
const claude = new Stated({ cwd: dir, agent: "Claude Code" });
await claude.init({ name: "MailMeld" });
await claude.registerAgent();

await claude.addGoal("Launch MailMeld");
const oauth = await claude.addTask({ title: "Build OAuth", priority: "high" });
await claude.claimTask(oauth.id);
await claude.startTask(oauth.id);
await claude.addDecision({ decision: "Use BullMQ", reason: "Reliable retries" });
await claude.claimFile("src/auth.ts");

// --- Codex joins later, with zero prior context ----------------------------
const codex = new Stated({ cwd: dir, agent: "Codex" });
await codex.registerAgent();

console.log("\n=== What Codex sees on arrival ===");
console.log(await codex.getHandoff());

// Codex tries to grab Claude's in-progress task — coordination prevents it.
try {
  await codex.claimTask(oauth.id);
} catch (err) {
  console.log("Codex was correctly blocked:", err.message);
}

// Codex picks up its own work instead.
const tests = await codex.addTask({ title: "Add OAuth tests" });
await codex.claimTask(tests.id);

console.log("\n=== Compact machine state ===");
console.log(JSON.stringify(await codex.getState(), null, 2));
