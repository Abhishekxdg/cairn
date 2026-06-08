import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { EventStore } from "../core/store.js";
import { agentPaths } from "../core/paths.js";
import { compileContext, type CompiledContext } from "./context.js";

/**
 * Fast recall.
 *
 * Recall (loading "where were we?") must be instant and dependency-free — an
 * agent should not have to run a tool or have anything on its PATH. So on every
 * state change AJP renders a tiny, always-current `.agent/CONTEXT.md`: a new
 * agent reads ONE small file and is fully oriented. `ajp recall` prints the same
 * thing for terminal use.
 */

/** Render a compiled context to compact, agent-friendly Markdown. */
export function renderRecall(ctx: CompiledContext): string {
  const L: string[] = ["# Where we are", ""];
  L.push(`Goal: ${ctx.goal || "(none set)"}`);
  L.push(
    `Current: ${ctx.currentTask ? `${ctx.currentTask.title} (${ctx.currentTask.id})` : "(nothing in progress)"}`,
  );
  L.push("");

  L.push("Active decisions:");
  if (ctx.activeDecisions.length) {
    for (const d of ctx.activeDecisions) {
      L.push(`- ${d.title}${d.rationale ? ` — ${d.rationale}` : ""}`);
    }
  } else L.push("- (none)");
  L.push("");

  L.push("Open tasks:");
  if (ctx.activeTasks.length) {
    for (const t of ctx.activeTasks) {
      L.push(`- [${t.status}] ${t.title} (${t.id})${t.owner ? ` @${t.owner}` : ""}`);
    }
  } else L.push("- (none)");
  L.push("");

  L.push("Recent activity:");
  if (ctx.recentActivity.length) {
    for (const e of ctx.recentActivity.slice(0, 6)) {
      L.push(`- ${e.summary}${e.actor ? ` — ${e.actor}` : ""}`);
    }
  } else L.push("- (nothing yet)");
  L.push("");

  L.push("Next:");
  ctx.recommendedNextActions.forEach((s, i) => L.push(`${i + 1}. ${s}`));
  L.push("");
  L.push(`_seq ${ctx.asOfSeq} · regenerated automatically — do not edit_`);
  return L.join("\n") + "\n";
}

/**
 * Recompute and write `.agent/CONTEXT.md`. Cheap (snapshot-accelerated context);
 * called after every state change so recall is always one file-read away.
 */
export function writeContextFile(store: EventStore, root: string): CompiledContext {
  const ctx = compileContext(store, { level: "small" });
  const dir = agentPaths(root).dir;
  // Only write when a journal dir exists (e.g. skip in :memory:/embedded use).
  if (existsSync(dir)) {
    writeFileSync(join(dir, "CONTEXT.md"), renderRecall(ctx));
  }
  return ctx;
}
