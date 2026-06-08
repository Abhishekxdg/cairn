#!/usr/bin/env node
// Wedge measurement: how cheaply does .agent/CONTEXT.md deliver orientation
// versus the blind reconstruction a cold agent does without it?
//
//   node scripts/wedge-eval.mjs [repoRoot]
//
// This is a PROXY (token cost of orientation), not the full behavioral A/B —
// that requires real external agents (see docs/experiments/context-wedge.md).
// It answers one concrete sub-question: orientation tokens, with vs without.

import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const root = process.argv[2] || process.cwd();
const tokens = (s) => Math.ceil(Buffer.byteLength(s, "utf8") / 4); // ~4 chars/token
const sh = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
};

// --- WITH CONTEXT.md: one small file read ----------------------------------
const ctxPath = join(root, ".agent", "CONTEXT.md");
if (!existsSync(ctxPath)) {
  console.error("No .agent/CONTEXT.md here. Run `ajp recall` first.");
  process.exit(1);
}
const ctx = readFileSync(ctxPath, "utf8");
const withTokens = tokens(ctx);

// What facts does CONTEXT.md carry? (the orientation payload)
const facts = {
  goal: /Goal:\s*(.+)/.exec(ctx)?.[1]?.trim() ?? "",
  decisions: (ctx.match(/^- .+ — .+$/gm) || []).length,
  nextActions: (ctx.match(/^\d+\. /gm) || []).length,
  recent: (ctx.match(/^- (Created|Modified|Deleted|Task|Decision|Agent)/gm) || []).length,
};

// --- WITHOUT CONTEXT.md: blind reconstruction proxy ------------------------
// A cold agent reconstructs by reading git log + the recently-changed files
// (mirrors the observed Codex behavior: "git log", "Explored 6 files").
const gitLog = sh("git", ["log", "-20", "--stat", "--pretty=format:%h %an %s"]);
const changed = sh("git", ["diff", "--name-only", "HEAD~5", "HEAD"])
  .split("\n")
  .map((s) => s.trim())
  .filter(Boolean)
  .slice(0, 6);

let fileTokens = 0;
let read = 0;
for (const f of changed) {
  const p = join(root, f);
  try {
    if (existsSync(p) && statSync(p).isFile()) {
      fileTokens += tokens(readFileSync(p, "utf8"));
      read++;
    }
  } catch {
    /* skip */
  }
}
const withoutTokens = tokens(gitLog) + fileTokens;

// --- report ----------------------------------------------------------------
const ratio = withoutTokens > 0 ? (withoutTokens / withTokens).toFixed(1) : "n/a";
console.log("\nCONTEXT.md wedge — orientation token cost (proxy)\n");
console.log(`  WITH .agent/CONTEXT.md   ${withTokens.toLocaleString()} tokens  (1 file read)`);
console.log(`  WITHOUT (reconstruct)    ${withoutTokens.toLocaleString()} tokens  (git log + ${read} files)`);
console.log(`  ratio                    ~${ratio}x cheaper with CONTEXT.md\n`);
console.log("  CONTEXT.md uniquely carries (git log/files do NOT surface cleanly):");
console.log(`    • goal:            ${facts.goal || "(none)"}`);
console.log(`    • active decisions+reasons: ${facts.decisions}`);
console.log(`    • recommended next actions: ${facts.nextActions}`);
console.log(`    • recent activity lines:    ${facts.recent}`);
console.log(
  "\n  Note: decisions + rationale + 'what to do next' are the high-value facts\n" +
    "  a cold agent CANNOT reliably reconstruct from code at any token cost.\n",
);
