#!/usr/bin/env node
// Build a STANDARDIZED, known-state repo for the CONTEXT.md wedge A/B — BLIND variant.
//
//   node scripts/wedge-fixture-blind.mjs [targetDir]   # default ./wedge-fixture-blind
//
// Same planted journal state as wedge-fixture.mjs, but the CODE leaks NOTHING.
// No "do not rebuild", no "Google", no "/auth/google", no "start here". README is
// deliberate misdirection (says the project is a transactional email API). ALL
// intent (goal = OAuth login, Google decision, route name, redirect-URI gotcha)
// lives ONLY in the journal. A cold agent should diverge; a journal-reader nails it.

import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const Cairn = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "cairn.js");
const target = resolve(process.argv[2] || join(process.cwd(), "wedge-fixture-blind"));

if (existsSync(target)) rmSync(target, { recursive: true, force: true });
mkdirSync(join(target, "src"), { recursive: true });

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: target, stdio: "ignore", ...opts });
const cairn = (args) => execFileSync("node", [Cairn, ...args], { cwd: target, stdio: "ignore" });
const file = (p, c) => writeFileSync(join(target, p), c);

// --- 1. the codebase (NEUTRAL — leaks no intent) ----------------------------
file("package.json", JSON.stringify({ name: "mailmeld", version: "0.1.0", type: "module" }, null, 2) + "\n");
file("README.md", "# MailMeld\n\nTransactional email API.\n");
file(
  "src/server.ts",
  `import express from "express";\n\nconst app = express();\napp.get("/health", (_req, res) => res.json({ ok: true }));\napp.listen(3000);\nexport { app };\n`,
);

// --- 2. git history (neutral messages; two commits = a real diff each) -------
run("git", ["init", "-q"]);
run("git", ["config", "user.email", "dev@mailmeld.dev"]);
run("git", ["config", "user.name", "Dev"]);
run("git", ["add", "-A"]);
run("git", ["commit", "-qm", "feat: server + health route"]);
file("src/auth.ts", `export function authRoute() {\n  throw new Error("not implemented");\n}\n`);
run("git", ["add", "-A"]);
run("git", ["commit", "-qm", "chore: scaffold auth module"]);

// --- 3. plant the journal (the KNOWN state — the ONLY place intent lives) ----
cairn(["init", "--no-agents"]);
const A = "Claude Code";
cairn(["append", "--type", "agent.registered", "--payload", '{"name":"Claude Code"}', "--actor", A]);
cairn(["append", "--type", "goal.created", "--payload", '{"id":"g1","title":"Ship OAuth login"}', "--actor", A]);
cairn(["append", "--type", "task.created", "--payload", '{"id":"t1","title":"Set up Express server"}', "--actor", A]);
cairn(["append", "--type", "task.completed", "--payload", '{"id":"t1"}', "--actor", A]);
cairn(["append", "--type", "decision.made", "--payload", '{"id":"d1","title":"Use Google OAuth","rationale":"users already have Google accounts"}', "--actor", A]);
cairn(["append", "--type", "knowledge.learned", "--payload", '{"statement":"Google OAuth requires the redirect URI to be allowlisted in the Google console"}', "--actor", A]);
cairn(["append", "--type", "task.created", "--payload", '{"id":"t2","title":"Build /auth/google route","priority":"high"}', "--actor", A]);
cairn(["append", "--type", "task.started", "--payload", '{"id":"t2"}', "--actor", A]);
cairn(["recall"]);

// --- 4. instructions ---------------------------------------------------------
const line = "─".repeat(70);
console.log(`\n✔ BLIND wedge fixture built at: ${target}\n`);
console.log(line);
console.log("CODE LEAKS NOTHING. All intent is journal-only. Run both arms blind.");
console.log(line);
console.log(`
  ARM CONTROL (no hint, journal must be ABSENT — move .agent out first):
    "Continue this project."

  ARM TREATMENT (journal present):
    "Read .agent/CONTEXT.md, then continue this project."

Grade blind on: right goal (OAuth login, NOT email)? · respected the Google
decision? · avoided redoing the Express server? · started /auth/google? · knew
the redirect-URI gotcha?

Expected: CONTROL diverges (works on email API per README, or invents own auth).
TREATMENT nails all five. The gap = the wedge.
`);
