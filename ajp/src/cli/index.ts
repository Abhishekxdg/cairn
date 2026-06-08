import { AgentJournal } from "../sdk/index.js";
import { init as coreInit, readManifest } from "../core/manifest.js";
import { findRoot, requireRoot, agentPaths } from "../core/paths.js";
import { EventStore } from "../core/store.js";
import { migrate, currentVersion, SCHEMA_VERSION } from "../core/schema.js";
import { health, validateIntegrity, repair } from "../engines/observability.js";
import { deriveState, activeTasks, activeDecisions, activeGoals } from "../engines/state.js";
import { compileContext, type ContextLevel } from "../engines/context.js";
import { deriveTimeline } from "../engines/memory.js";
import { renderTimeline } from "../engines/timeline.js";
import { detectGit } from "../engines/git.js";
import { pruneAgents } from "../engines/agents.js";
import { compactJournal } from "../engines/compaction.js";

const VERSION = "0.1.0";

// --- styling -----------------------------------------------------------------
const useColor = process.stdout.isTTY && process.env["NO_COLOR"] === undefined;
const w = (code: string) => (s: string) => (useColor ? `[${code}m${s}[0m` : s);
const c = {
  bold: w("1"), dim: w("2"), red: w("31"), green: w("32"),
  yellow: w("33"), cyan: w("36"), gray: w("90"),
};
const out = (s = ""): void => { process.stdout.write(s + "\n"); };
const err = (s = ""): void => { process.stderr.write(s + "\n"); };

// --- arg parsing -------------------------------------------------------------
interface Parsed { positionals: string[]; flags: Record<string, string | boolean>; }
function parse(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const eq = key.indexOf("=");
      if (eq !== -1) flags[key.slice(0, eq)] = key.slice(eq + 1);
      else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) { flags[key] = next; i++; }
        else flags[key] = true;
      }
    } else positionals.push(a);
  }
  return { positionals, flags };
}
const fstr = (f: Parsed["flags"], k: string) => (typeof f[k] === "string" ? (f[k] as string) : undefined);
const actorOf = (f: Parsed["flags"]) => fstr(f, "actor") ?? process.env["AJP_ACTOR"] ?? "cli";

function openStore(): EventStore {
  return new EventStore(agentPaths(requireRoot()).db);
}

const HELP = `${c.bold("ajp")} — Agent Journal Protocol · the Git of AI memory

${c.bold("USAGE")}
  ajp <command> [args] [--flags]

${c.bold("COMMANDS")}
  init                       Create a .agent/ journal here
  status                     Show derived project state
  append --type T            Append an event (--payload '<json>' --actor N)
  state                      Print full derived state (JSON)
  timeline                   Human-readable timeline (--since <seq> --type T)
  context [--level L]        Compile minimum-token context (small|medium|large|full)
  snapshot                   Force a state snapshot
  compact                    Cold-archive old events + reclaim space (--keep-recent N)
  prune                      Disconnect stale agents (--idle-ms N)
  export                     Export the full journal (hot + archive) as JSON
  doctor                     Health + integrity report
  migrate                    Apply pending schema migrations
  repair                     Rebuild indexes + vacuum (history untouched)
  mcp                        Start the MCP server (stdio)

${c.bold("FLAGS")}
  --actor <name>   Attribute appended events (or AJP_ACTOR)
  --json           Machine-readable output
  --version, -h    Version / help

${c.bold("EXAMPLE")}
  ajp init
  ajp append --type decision.made --payload '{"title":"Use SQLite","rationale":"WAL concurrency"}' --actor "Claude Code"
  ajp context --level small
`;

type Handler = (rest: string[], flags: Parsed["flags"]) => void | Promise<void>;

const commands: Record<string, Handler> = {
  init(_rest, flags) {
    const cwd = process.cwd();
    if (findRoot(cwd) && !flags["force"]) {
      out(c.yellow("⚠ .agent/ already initialized. Use --force to reinitialize."));
      return;
    }
    const res = coreInit(cwd, {
      ...(fstr(flags, "name") ? { name: fstr(flags, "name")! } : {}),
      force: Boolean(flags["force"]),
    });
    out(c.green("✔ Initialized Agent Journal at .agent/"));
    out(c.dim(`  projectId: ${res.projectId}`));
    const git = detectGit(cwd);
    if (git.isRepo) out(c.dim(`  git: ${git.branch ?? "(detached)"}`));
    out(c.dim('  Next: ajp append --type agent.registered --payload \'{"name":"Claude Code"}\''));
  },

  status(_rest, flags) {
    const store = openStore();
    try {
      const state = deriveState(store);
      if (flags["json"]) return out(JSON.stringify(state, null, 2));
      const m = readManifest(requireRoot());
      out(c.bold(`\n  ${m.name} ${c.dim(`(${state.projectId})`)}`));
      out(c.dim(`  ${store.count()} events · seq ${state.lastSeq}`));
      out("");
      const goal = activeGoals(state)[0];
      out(`  ${c.bold("Goal")}      ${goal ? goal.title : c.dim("(none)")}`);
      out("");
      out(c.bold("  Active Tasks"));
      const tasks = activeTasks(state);
      if (tasks.length) for (const t of tasks) {
        out(`    ${c.cyan(`[${t.status}]`.padEnd(10))} ${t.title} ${c.gray(t.id)}${t.owner ? c.dim(` @${t.owner}`) : ""}`);
      } else out(c.dim("    (none)"));
      out("");
      out(c.bold("  Active Decisions"));
      const decs = activeDecisions(state);
      if (decs.length) for (const d of decs) out(`    • ${d.title}${d.rationale ? c.dim(` — ${d.rationale}`) : ""}`);
      else out(c.dim("    (none)"));
      out("");
      out(c.bold("  Agents"));
      const live = state.agents.filter((a) => a.liveness === "active");
      if (live.length) for (const a of live) out(`    ${c.green("●")} ${a.name} ${c.dim(`(${a.type})`)}`);
      else out(c.dim("    (none active)"));
      out("");
    } finally {
      store.close();
    }
  },

  append(_rest, flags) {
    const type = fstr(flags, "type");
    if (!type) throw new Error("append requires --type <event.type>");
    let payload: Record<string, unknown> = {};
    const raw = fstr(flags, "payload");
    if (raw) {
      try { payload = JSON.parse(raw); }
      catch { throw new Error("--payload must be valid JSON"); }
    }
    const journal = new AgentJournal({ actor: actorOf(flags) });
    try {
      const ev = journal.appendEvent({ type, payload });
      if (flags["json"]) out(JSON.stringify(ev, null, 2));
      else out(c.green(`✔ ${ev.type} ${c.gray(`#${ev.seq} ${ev.id}`)}`));
    } finally {
      journal.close();
    }
  },

  state(_rest, _flags) {
    const store = openStore();
    try { out(JSON.stringify(deriveState(store), null, 2)); }
    finally { store.close(); }
  },

  timeline(_rest, flags) {
    const store = openStore();
    try {
      const days = deriveTimeline(store, {
        ...(fstr(flags, "since") ? { sinceSeq: Number(fstr(flags, "since")) } : {}),
        ...(fstr(flags, "type") ? { types: [fstr(flags, "type")!] } : {}),
      });
      if (flags["json"]) return out(JSON.stringify(days, null, 2));
      out(renderTimeline(days));
    } finally { store.close(); }
  },

  context(_rest, flags) {
    const store = openStore();
    try {
      const level = (fstr(flags, "level") as ContextLevel) ?? "medium";
      const ctx = compileContext(store, { level });
      out(JSON.stringify(ctx, null, 2));
    } finally { store.close(); }
  },

  snapshot(_rest, _flags) {
    const journal = new AgentJournal({ actor: "ajp" });
    try { out(c.green(`✔ Snapshot at seq ${journal.snapshot()}`)); }
    finally { journal.close(); }
  },

  compact(_rest, flags) {
    const store = openStore();
    try {
      const keep = fstr(flags, "keep-recent");
      const jr = compactJournal(store, keep ? { keepRecent: Number(keep) } : {});
      const pr = store.compact();
      if (flags["json"]) return out(JSON.stringify({ journal: jr, pages: pr }, null, 2));
      out(c.green(`✔ Archived ${jr.archived} events (cut seq ${jr.cutSeq}); hot table now ${jr.remaining}`));
      out(c.dim(`  reclaimed: ${pr.before} → ${pr.after} pages`));
    } finally { store.close(); }
  },

  prune(_rest, flags) {
    const store = openStore();
    try {
      const idle = fstr(flags, "idle-ms");
      const r = pruneAgents(store, {
        actor: actorOf(flags),
        ...(idle ? { idleMs: Number(idle) } : {}),
      });
      if (flags["json"]) return out(JSON.stringify(r, null, 2));
      out(r.pruned.length
        ? c.green(`✔ Pruned ${r.pruned.length} stale agent(s): ${r.pruned.join(", ")}`)
        : c.dim("No stale agents to prune."));
    } finally { store.close(); }
  },

  export(_rest, flags) {
    const store = openStore();
    try {
      const events = store.exportEvents();
      out(flags["pretty"] ? JSON.stringify(events, null, 2) : JSON.stringify(events));
    } finally { store.close(); }
  },

  doctor(_rest, flags) {
    const store = openStore();
    try {
      const h = health(store);
      const integ = validateIntegrity(store);
      if (flags["json"]) return out(JSON.stringify({ health: h, integrity: integ }, null, 2));
      out(`${h.ok ? c.green("✔") : c.yellow("⚠")} ${h.total} events (${h.events} hot, ${h.archived} archived) · seq ${h.lastSeq} · ${h.snapshots} snapshots (lag ${h.snapshotLag})`);
      out(`  schema v${h.schemaVersion} (expected v${h.expectedSchemaVersion})`);
      for (const i of h.issues) out(c.yellow(`  ⚠ ${i}`));
      out(`${integ.healthy ? c.green("✔") : c.red("✖")} integrity: checked ${integ.checked} events`);
      for (const p of integ.problems) out(c.red(`  ✖ ${p}`));
      out("");
      out(h.ok && integ.healthy ? c.green("Healthy.") : c.red("Problems found."));
      if (!(h.ok && integ.healthy)) process.exitCode = 1;
    } finally { store.close(); }
  },

  migrate(_rest, _flags) {
    const store = openStore();
    try {
      const before = currentVersion(store.db);
      const after = migrate(store.db);
      out(after > before
        ? c.green(`✔ Migrated schema v${before} → v${after}`)
        : c.dim(`Already at schema v${after} (latest ${SCHEMA_VERSION})`));
    } finally { store.close(); }
  },

  repair(_rest, _flags) {
    const store = openStore();
    try {
      for (const a of repair(store).actions) out(c.green(`✔ ${a}`));
    } finally { store.close(); }
  },

  async mcp(_rest, _flags) {
    const { startStdioServer } = await import("../mcp/server.js");
    await startStdioServer();
    await new Promise<never>(() => {});
  },
};

/** CLI entry point. Returns an exit code. */
export async function run(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { positionals, flags } = parse(argv);
  const cmd = positionals[0];
  if (flags["version"] || flags["v"] || cmd === "version") { out(VERSION); return 0; }
  if (!cmd || flags["help"] || flags["h"] || cmd === "help") { out(HELP); return 0; }
  const handler = commands[cmd];
  if (!handler) {
    err(c.red(`Unknown command: ${cmd}`));
    err(c.dim("Run `ajp --help` for usage."));
    return 1;
  }
  try {
    await handler(positionals.slice(1), flags);
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  } catch (e) {
    err(c.red(`✖ ${(e as Error).message}`));
    return 1;
  }
}
