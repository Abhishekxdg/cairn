#!/usr/bin/env node
// Build a STANDARDIZED, known-state repo for the CONTEXT.md wedge A/B.
//
//   node scripts/wedge-fixture.mjs [targetDir]   # default ./wedge-fixture
//
// Produces a small "MailMeld" project whose journal has a planted, knowable
// state: one finished task (a trap to redo), one active decision with a reason
// (a trap to re-litigate), one in-progress task (the correct next step), and a
// piece of knowledge code can't reveal. Then prints the two-arm prompts and
// where the answer key lives. Run the same fixture against each agent.

import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const AJP = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "ajp.js");
const target = resolve(process.argv[2] || join(process.cwd(), "wedge-fixture"));

if (existsSync(target)) rmSync(target, { recursive: true, force: true });
mkdirSync(join(target, "src"), { recursive: true });

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: target, stdio: "ignore", ...opts });
const ajp = (args) => execFileSync("node", [AJP, ...args], { cwd: target, stdio: "ignore" });
const file = (p, c) => writeFileSync(join(target, p), c);

// --- 1. the codebase (what a COLD agent must reconstruct from) --------------
file("package.json", JSON.stringify({ name: "mailmeld", version: "0.1.0", type: "module" }, null, 2) + "\n");
file("README.md", "# MailMeld\n\nTransactional email API.\n");
file(
  "src/server.ts",
  `import express from "express";\n\n// Express server — DONE (do not rebuild).\nconst app = express();\napp.get("/health", (_req, res) => res.json({ ok: true }));\napp.listen(3000);\nexport { app };\n`,
);
file(
  "src/auth.ts",
  `// Auth — IN PROGRESS. The Google OAuth route is a stub.\nexport function googleAuthRoute() {\n  // TODO: implement /auth/google\n  throw new Error("not implemented");\n}\n`,
);

// --- 2. git history ----------------------------------------------------------
run("git", ["init", "-q"]);
run("git", ["config", "user.email", "dev@mailmeld.dev"]);
run("git", ["config", "user.name", "Dev"]);
run("git", ["add", "-A"]);
run("git", ["commit", "-qm", "feat: express server + health route"]);
file("src/auth.ts", "// Auth — IN PROGRESS. The Google OAuth route is a stub.\nexport function googleAuthRoute() {\n  // TODO: implement /auth/google (start here)\n  throw new Error(\"not implemented\");\n}\n");
run("git", ["add", "-A"]);
run("git", ["commit", "-qm", "chore: scaffold auth module"]);

// --- 3. plant the journal (the KNOWN state) ---------------------------------
ajp(["init", "--no-agents"]); // journal only; we set rules below deterministically
const A = "Claude Code";
ajp(["append", "--type", "agent.registered", "--payload", '{"name":"Claude Code"}', "--actor", A]);
ajp(["append", "--type", "goal.created", "--payload", '{"id":"g1","title":"Ship OAuth login"}', "--actor", A]);
// Finished work (trap: a cold agent may rebuild the server).
ajp(["append", "--type", "task.created", "--payload", '{"id":"t1","title":"Set up Express server"}', "--actor", A]);
ajp(["append", "--type", "task.completed", "--payload", '{"id":"t1"}', "--actor", A]);
// Active decision WITH reason (trap: a cold agent may pick a different provider).
ajp(["append", "--type", "decision.made", "--payload", '{"id":"d1","title":"Use Google OAuth","rationale":"users already have Google accounts"}', "--actor", A]);
// Knowledge code cannot reveal.
ajp(["append", "--type", "knowledge.learned", "--payload", '{"statement":"Google OAuth requires the redirect URI to be allowlisted in the Google console"}', "--actor", A]);
// In-progress task = the CORRECT next step.
ajp(["append", "--type", "task.created", "--payload", '{"id":"t2","title":"Build /auth/google route","priority":"high"}', "--actor", A]);
ajp(["append", "--type", "task.started", "--payload", '{"id":"t2"}', "--actor", A]);
ajp(["recall"]); // refresh CONTEXT.md

// --- 4. instructions ---------------------------------------------------------
const line = "─".repeat(70);
console.log(`\n✔ Wedge fixture built at: ${target}\n`);
console.log(line);
console.log("RUN THIS AGAINST EACH AGENT (Codex / Claude Code / Cursor / OpenHands)");
console.log(line);
console.log(`
For each agent, open the fixture folder in a FRESH session and run BOTH arms
(new chat each). Use the same 3 task prompts.

  ARM CONTROL (no hint):
    "Continue this project."

  ARM TREATMENT (read context first):
    "Read .agent/CONTEXT.md, then continue this project."

3 task prompts (swap "Continue this project." for each):
  T1  "Continue this project."
  T2  "Add the login feature."
  T3  "What's left to do here?"

ANSWER KEY (what 'correct' looks like) + blank scoring sheet:
  docs/experiments/wedge-fixture.md

Grade blind on: right goal? · respected the Google decision? · avoided redoing
the Express server? · started /auth/google? · knew the redirect-URI gotcha?
`);
