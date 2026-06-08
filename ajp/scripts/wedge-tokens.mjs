#!/usr/bin/env node
// Token benchmark for the CONTEXT.md wedge — the headline stat.
//
//   npm run build && node scripts/wedge-tokens.mjs <fixtureDir>
//
// Quantifies the core product claim: "a small read replaces a big scan."
//   baseline (cold orient) = the bytes a fresh agent must scan to reconstruct
//                            context with NO journal (all source it would read).
//   ajp     (warm orient)  = reading .agent/CONTEXT.md.
// Both measured with the SAME estimator, so the ratio is honest.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { estimateTokens, compareTokens } from "../dist/engines/tokens.js";

const fixture = process.argv[2];
if (!fixture || !existsSync(fixture)) {
  console.error("usage: node scripts/wedge-tokens.mjs <fixtureDir>");
  process.exit(1);
}

// Directories a cold agent does NOT count as "reading to orient".
const SKIP = new Set([".git", "node_modules", "dist", ".agent", "_agent_hidden"]);

/** Concatenate every source file a cold agent would scan to reconstruct context. */
function coldScanText(dir) {
  let out = "";
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out += coldScanText(p);
    else out += readFileSync(p, "utf8") + "\n";
  }
  return out;
}

/** Find the journal's CONTEXT.md whether the dir is live or has it stashed. */
function contextText(dir) {
  for (const rel of [".agent/CONTEXT.md", "_agent_hidden/CONTEXT.md"]) {
    const p = join(dir, rel);
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  return null;
}

const cold = coldScanText(fixture);
const ctx = contextText(fixture);
if (ctx === null) {
  console.error(`No CONTEXT.md found under ${fixture} (.agent or _agent_hidden).`);
  process.exit(1);
}

const cmp = compareTokens(cold, ctx);
const line = "─".repeat(58);
console.log(`\nToken wedge — ${fixture}\n${line}`);
console.log(`Cold orient (scan all source) : ${cmp.baselineTokens.toLocaleString()} tok`);
console.log(`AJP orient  (read CONTEXT.md) : ${cmp.ajpTokens.toLocaleString()} tok`);
console.log(line);
console.log(`Saved                         : ${cmp.saved.toLocaleString()} tok`);
console.log(`Cheaper                       : ${cmp.ratio}x\n`);
console.log(`(estimator: ~${estimateTokens("test test test test") / 4} tok/short-word blend; ratio is estimator-independent)\n`);
