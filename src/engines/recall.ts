import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { EventStore } from "../core/store.js";
import { agentPaths } from "../core/paths.js";
import { compileContext, type CompiledContext } from "./context.js";
import { estimateTokens } from "./tokens.js";

/**
 * Fast recall.
 *
 * Recall (loading "where were we?") must be instant and dependency-free — an
 * agent should not have to run a tool or have anything on its PATH. So on every
 * state change Cairn renders a tiny, always-current `.agent/CONTEXT.md`: a new
 * agent reads ONE small file and is fully oriented. `cairn recall` prints the same
 * thing for terminal use.
 *
 * The whole bet is "a small read replaces a big scan", so CONTEXT.md has a hard
 * TOKEN BUDGET. We render sections most-valuable-first and drop the lowest-value
 * lines (recent activity, then extra tasks/decisions) until the body fits. The
 * footer always reports the realized token count so the savings are measurable.
 */

/** Default ceiling for CONTEXT.md body, in estimated tokens. */
export const DEFAULT_RECALL_BUDGET = 1500;

/**
 * Fraction of the total budget anchors may consume. Caps the non-droppable
 * spine so a flood of pins can't starve the rest of the recall; the overflow
 * collapses to a "+N more" pointer ranked by anchor weight.
 */
export const ANCHOR_BUDGET_FRACTION = 0.5;

/** Max characters for a never-dropped spine line (goal/current). Keeps the
 *  budget floor small so an oversized goal can't blow the token ceiling. */
export const MAX_SPINE_LINE = 140;

/** Clip a string to `n` chars with an ellipsis, on a word boundary if cheap. */
function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + "…";
}

/**
 * Compact relative age (e.g. "2d", "3h", "now") from an ISO timestamp to a
 * reference time. Provenance: showing how OLD a fact is lets the agent judge
 * whether to trust and act on it, instead of reading past it.
 */
export function relAge(iso: string, nowIso: string): string {
  const then = Date.parse(iso);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(then) || !Number.isFinite(now)) return "";
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 60) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.round(mo / 12)}y`;
}

export interface RenderOptions {
  /** Hard token ceiling for the body. Default DEFAULT_RECALL_BUDGET. */
  budget?: number;
  /** Commits since the context was compiled (drift signal). */
  driftCommits?: number;
}

/** A renderable line tagged with how droppable it is (higher = dropped first). */
interface Section {
  /** Lines of this section, header first. */
  lines: string[];
  /** 0 = never drop; larger = drop sooner under budget pressure. */
  dropRank: number;
}

/** Render a compiled context to compact, agent-friendly Markdown within budget. */
export function renderRecall(ctx: CompiledContext, opts: RenderOptions = {}): string {
  const budget = opts.budget ?? DEFAULT_RECALL_BUDGET;

  const now = ctx.generatedAt;

  // Always-present spine (never dropped). Spine lines are CLIPPED so a pathologically
  // long goal/title can't blow the token ceiling — the spine must stay a small,
  // bounded floor for the budget to mean anything.
  const head: string[] = [
    "# Where we are",
    "",
    `Goal: ${clip(ctx.goal || "(none set)", MAX_SPINE_LINE)}`,
    `Current: ${ctx.currentTask ? `${clip(ctx.currentTask.title, MAX_SPINE_LINE)} (${ctx.currentTask.id})` : "(nothing in progress)"}`,
    "",
  ];

  // Memory residual: foundational facts get a guaranteed shortcut into the doc.
  // They live in the spine (not the droppable `sections`), so the recency drop
  // loop can never trim away the early signal — the whole point of an anchor.
  //
  // But anchors must not be able to eat the WHOLE budget: with hundreds of pins
  // the spine would blow past the ceiling. So anchors get a SUB-BUDGET and are
  // filled in ranked (highest-weight) order; the overflow collapses to a single
  // "+N more" pointer. Survival becomes "top-ranked pins always present, the
  // tail discoverable" instead of "all pins or bust".
  const anchorIds = new Set(ctx.anchors.map((a) => a.id));
  if (ctx.anchors.length) {
    const anchorBudget = Math.max(0, Math.floor(budget * ANCHOR_BUDGET_FRACTION));
    head.push("Anchors:");
    let used = estimateTokens("Anchors:");
    let shown = 0;
    for (const a of ctx.anchors) {
      const age = a.at ? relAge(a.at, now) : "";
      const tag = a.kind === "decision" ? "decision" : "fact";
      const line = `- (${tag}) ${clip(a.text, MAX_SPINE_LINE)}${age ? ` _(${age})_` : ""}`;
      const cost = estimateTokens(line);
      // Always show the single highest-ranked anchor; ration the rest.
      if (shown > 0 && used + cost > anchorBudget) break;
      head.push(line);
      used += cost;
      shown++;
    }
    const dropped = ctx.anchors.length - shown;
    if (dropped > 0) head.push(`- …+${dropped} more anchored (run \`cairn anchors\`)`);
    head.push("");
  }

  const decisions: Section = { dropRank: 2, lines: ["Active decisions:"] };
  // Anchored decisions already shown above — don't repeat them here.
  const droppableDecisions = ctx.activeDecisions.filter((d) => !anchorIds.has(d.id));
  if (droppableDecisions.length) {
    for (const d of droppableDecisions) {
      const age = d.at ? relAge(d.at, now) : "";
      const prov = ` _(${d.id}${age ? ` · ${age}` : ""})_`;
      decisions.lines.push(`- ${d.title}${d.rationale ? ` — ${d.rationale}` : ""}${prov}`);
    }
  } else {
    const anchoredDecisions = ctx.anchors.some((a) => a.kind === "decision");
    decisions.lines.push(anchoredDecisions ? "- (all anchored — see Anchors)" : "- (none)");
  }

  const tasks: Section = { dropRank: 3, lines: ["Open tasks:"] };
  if (ctx.activeTasks.length) {
    for (const t of ctx.activeTasks) {
      tasks.lines.push(`- [${t.status}] ${t.title} (${t.id})${t.owner ? ` @${t.owner}` : ""}`);
    }
  } else tasks.lines.push("- (none)");

  // Next actions are high-value (they tell the agent what to DO).
  const next: Section = { dropRank: 1, lines: ["Next:"] };
  ctx.recommendedNextActions.forEach((s, i) => next.lines.push(`${i + 1}. ${s}`));

  // Recent activity is the lowest-value, most verbose section → dropped first.
  const activity: Section = { dropRank: 4, lines: ["Recent activity:"] };
  if (ctx.recentActivity.length) {
    for (const e of ctx.recentActivity.slice(0, 6)) {
      const age = e.at ? relAge(e.at, now) : "";
      activity.lines.push(`- ${e.summary}${e.actor ? ` — ${e.actor}` : ""}${age ? ` _(${age})_` : ""}`);
    }
  } else activity.lines.push("- (nothing yet)");

  // Decisions before tasks before next before activity in the document, but
  // dropped in reverse value order under budget pressure.
  const sections: Section[] = [decisions, tasks, next, activity];

  const footer = (bodyTokens: number) => {
    const drift =
      opts.driftCommits && opts.driftCommits > 0
        ? ` · ${opts.driftCommits} commit${opts.driftCommits === 1 ? "" : "s"} since`
        : "";
    return `_seq ${ctx.asOfSeq} · ~${bodyTokens} tokens${drift} · regenerated automatically — do not edit_`;
  };

  // Greedily include whole sections in document order, trimming the most
  // droppable section's body lines first when over budget.
  const assemble = (incl: Section[]): string => {
    const body: string[] = [...head];
    for (const s of incl) {
      body.push(...s.lines, "");
    }
    const bodyText = body.join("\n");
    const bodyTokens = estimateTokens(bodyText);
    return [bodyText, footer(bodyTokens)].join("\n") + "\n";
  };

  let included = [...sections];
  let out = assemble(included);
  // Drop sections (highest dropRank first) until the whole doc fits the budget.
  const byDrop = [...sections].sort((a, b) => b.dropRank - a.dropRank);
  let di = 0;
  while (estimateTokens(out) > budget && di < byDrop.length) {
    const victim = byDrop[di++]!;
    // First try trimming the victim's body to just its header; if still over on
    // the next loop, the section gets removed entirely.
    if (victim.lines.length > 1) {
      victim.lines = [victim.lines[0]!, "  …(trimmed for budget)"];
      out = assemble(included);
      if (estimateTokens(out) <= budget) break;
    }
    included = included.filter((s) => s !== victim);
    out = assemble(included);
  }

  // Emergency spine degradation: if even the bare spine (oversized goal + the
  // mandatory ≥1 anchor) exceeds the budget, fall back to a minimal doc — just
  // the goal, clipped to fit — so the budget is HARD down to a tiny skeleton
  // floor (~the header + a clipped goal + footer), not merely best-effort.
  if (estimateTokens(out) > budget) {
    const minimal = (goalText: string): string => {
      const body = ["# Where we are", `Goal: ${goalText}`].join("\n");
      return [body, footer(estimateTokens(body))].join("\n") + "\n";
    };
    let g = clip(ctx.goal || "(none set)", MAX_SPINE_LINE);
    let m = minimal(g);
    while (estimateTokens(m) > budget && g.length > 1) {
      g = clip(g, Math.max(1, Math.floor(g.length * 0.7)));
      m = minimal(g);
    }
    out = m;
  }
  return out;
}

/**
 * Recompute and write `.agent/CONTEXT.md`. Cheap (snapshot-accelerated context);
 * called after every state change so recall is always one file-read away.
 */
export function writeContextFile(
  store: EventStore,
  root: string,
  opts: RenderOptions = {},
): CompiledContext {
  const ctx = compileContext(store, { level: "small" });
  const dir = agentPaths(root).dir;
  // Only write when a journal dir exists (e.g. skip in :memory:/embedded use).
  if (existsSync(dir)) {
    writeFileSync(join(dir, "CONTEXT.md"), renderRecall(ctx, opts));
  }
  return ctx;
}
