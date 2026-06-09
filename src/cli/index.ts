import { AgentJournal } from "../sdk/index.js";
import { init as coreInit, readManifest } from "../core/manifest.js";
import { findRoot, requireRoot, agentPaths } from "../core/paths.js";
import { EventStore } from "../core/store.js";
import { migrate, currentVersion, SCHEMA_VERSION } from "../core/schema.js";
import { health, validateIntegrity, repair } from "../engines/observability.js";
import { deriveState, activeTasks, activeDecisions, activeGoals } from "../engines/state.js";
import { compileContext, type ContextLevel } from "../engines/context.js";
import { rankFiles, compileTaskContext } from "../engines/relevance.js";
import { indexRepo } from "../engines/codegraph.js";
import { watchCode } from "../engines/codewatch.js";
import { deriveTimeline } from "../engines/memory.js";
import { renderTimeline } from "../engines/timeline.js";
import { detectGit } from "../engines/git.js";
import { pruneAgents } from "../engines/agents.js";
import { compactJournal } from "../engines/compaction.js";
import { syncGit, gitDrift } from "../engines/gitsync.js";
import { writeContextFile, renderRecall } from "../engines/recall.js";
import { sendMessage, inbox, history, listTeams } from "../engines/chat.js";
import { setActiveTeam, getActiveTeam, clearActiveTeam, listMembershipTeams, inboxCooldownOk } from "../engines/chat-membership.js";
import { setupProject, refreshProjectRules } from "../setup/install.js";
import { installGlobal, uninstallGlobal, refreshGlobalRules } from "../setup/global.js";
import { notifyIfUpdate } from "../engines/update.js";
import { renderProjectSetup, renderGlobalSetup } from "./screens.js";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Read version from package.json so it never drifts from the published version.
const VERSION = (() => {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "../../package.json");
    return JSON.parse(readFileSync(pkgPath, "utf8")).version as string;
  } catch {
    return "0.0.0";
  }
})();

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
const actorOf = (f: Parsed["flags"]) => fstr(f, "actor") ?? process.env["CAIRN_ACTOR"] ?? "cli";

function openStore(): EventStore {
  return new EventStore(agentPaths(requireRoot()).db);
}

const HELP = `${c.bold("cairn")} — Cairn · the Git of AI memory

${c.bold("USAGE")}
  cairn <command> [args] [--flags]

${c.bold("COMMANDS")}
  init                       Create a .agent/ journal + teach coding agents
  setup                      Re-teach coding agents (writes Cairn rules to their files)
  install-global             Wire global agent rules so agents self-setup every repo
  uninstall-global           Remove the global bootstrap rules
  upgrade                    Update cairn globally + refresh agent rules
  status                     Show derived project state
  append --type T            Append an event (--payload '<json>' --actor N)
  state                      Print full derived state (JSON)
  timeline                   Human-readable timeline (--since <seq> --type T)
  recall                     Instant "where were we" (also written to .agent/CONTEXT.md)
  context [--level L]        Compile minimum-token context (small|medium|large|full)
  context --task "<desc>"    Task-scoped context: + relevant files & related decisions
  relevant "<task>"          Rank the files a task most likely touches (--k N --json)
  index                      Build the static code graph (imports + exports) for cold-start
  watch                      Live-reindex the code graph on every save (--debounce ms)
  sync                       Capture commits as events + extract decisions (--full, --no-extract)
  snapshot                   Force a state snapshot
  compact                    Cold-archive old events + reclaim space (--keep-recent N)
  prune                      Disconnect stale agents (--idle-ms N)
  export                     Export the full journal (hot + archive) as JSON
  doctor                     Health + integrity report
  migrate                    Apply pending schema migrations
  repair                     Rebuild indexes + vacuum (history untouched)
  mcp                        Start the MCP server (stdio)
  chat <verb>                Realtime agent chat (send|inbox|tail|history|teams|join|leave)

${c.bold("FLAGS")}
  --actor <name>   Attribute appended events (or CAIRN_ACTOR)
  --json           Machine-readable output
  --version, -h    Version / help

${c.bold("EXAMPLE")}
  cairn init
  cairn append --type decision.made --payload '{"title":"Use SQLite","rationale":"WAL concurrency"}' --actor "Claude Code"
  cairn context --level small
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
    // Teach the coding agents (unless --no-agents), then show the nice screen.
    const s = flags["no-agents"]
      ? { root: res.root, initializedJournal: true, filesCreated: [], filesUpdated: [], gitHook: false, sessionHook: false, filesIndexed: 0 }
      : setupProject(cwd, { all: Boolean(flags["all"]) });
    // Build the static code index now, so cold-start "task → files" works on the
    // very first message — before any commit history exists. Best-effort.
    if (!flags["no-index"]) {
      try {
        const store = new EventStore(agentPaths(res.root).db);
        try {
          const idx = indexRepo(res.root, { actor: actorOf(flags) });
          if (idx.events.length) store.batchAppend(idx.events);
        } finally { store.close(); }
      } catch { /* indexing is best-effort; never block init */ }
    }
    out(renderProjectSetup({ ...s, initializedJournal: true }));
  },

  "install-global"(_rest, flags) {
    const r = installGlobal({ all: Boolean(flags["all"]) });
    if (flags["json"]) return out(JSON.stringify(r, null, 2));
    out(renderGlobalSetup(r));
  },

  "uninstall-global"(_rest, flags) {
    const r = uninstallGlobal();
    if (flags["json"]) return out(JSON.stringify(r, null, 2));
    out(r.filesUpdated.length
      ? c.green(`✔ Removed global bootstrap from: ${r.filesUpdated.join(", ")}`)
      : c.dim("No global bootstrap found."));
  },

  upgrade(_rest, _flags) {
    // Update the global package, then self-heal global rules to the new version.
    out(c.dim("Updating @memxai/cairn globally…"));
    try {
      execFileSync("npm", ["install", "-g", "@memxai/cairn@latest"], { stdio: "inherit" });
    } catch {
      err(c.red("✖ npm update failed. Run manually: npm i -g @memxai/cairn@latest"));
      process.exitCode = 1;
      return;
    }
    const g = refreshGlobalRules();
    out(c.green("✔ Upgraded.") + (g.length ? c.dim(` Refreshed global rules in ${g.length} file(s).`) : ""));
    out(c.dim("  In each repo, the next `cairn sync` (post-commit) refreshes its rules."));
  },

  setup(_rest, flags) {
    const cwd = process.cwd();
    // Running `cairn setup` IS consent, so build the code graph by default
    // (`--no-index` to skip). This is the fallback path postinstall points at
    // when it couldn't prompt (no TTY).
    const r = setupProject(cwd, { all: Boolean(flags["all"]), buildIndex: !flags["no-index"] });
    if (flags["json"]) return out(JSON.stringify(r, null, 2));
    out(renderProjectSetup(r));
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

  context(rest, flags) {
    const store = openStore();
    try {
      const level = (fstr(flags, "level") as ContextLevel) ?? "medium";
      const task = (fstr(flags, "task") ?? rest.join(" ").trim()) || undefined;
      const ctx = task
        ? compileTaskContext(store, task, { level, ...(fstr(flags, "k") ? { k: Number(fstr(flags, "k")) } : {}) })
        : compileContext(store, { level });
      out(JSON.stringify(ctx, null, 2));
    } finally { store.close(); }
  },

  index(_rest, flags) {
    const r = requireRoot();
    const store = openStore();
    try {
      const res = indexRepo(r, { actor: actorOf(flags) });
      const before = store.count();
      if (res.events.length) store.batchAppend(res.events);
      const added = store.count() - before;
      if (flags["json"]) return out(JSON.stringify({ ...res, events: res.events.length, added }, null, 2));
      out(c.green(`✔ Indexed ${res.files} files · ${res.edges} import edges · ${res.symbols} symbols`));
      out(c.dim(added ? `  ${added} new/changed file(s) recorded` : "  index already up to date"));
    } finally { store.close(); }
  },

  async watch(_rest, flags) {
    const r = requireRoot();
    const store = openStore();
    const debounce = fstr(flags, "debounce") ? Number(fstr(flags, "debounce")) : undefined;
    const handle = watchCode(store, r, {
      actor: actorOf(flags),
      ...(debounce ? { debounceMs: debounce } : {}),
      onIndex: (path, recorded) =>
        out(recorded ? c.green(`↻ ${path}`) : c.dim(`· ${path} (no change)`)),
      onSkip: (path) => out(c.yellow(`⏳ ${path} (mid-edit, skipped)`)),
    });
    out(c.bold("cairn watch") + c.dim(` — live code-graph indexing (debounce ${debounce ?? 2500}ms). Ctrl-C to stop.`));
    await new Promise<void>((resolve) => {
      const stop = () => {
        handle.close();
        store.close();
        out(c.dim(`\nstopped · ${handle.stats.recorded} change(s) recorded, ${handle.stats.skipped} skipped`));
        resolve();
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });
  },

  relevant(rest, flags) {
    const query = (fstr(flags, "task") ?? rest.join(" ")).trim();
    if (!query) throw new Error('relevant requires a task description, e.g. cairn relevant "add payment retries"');
    const store = openStore();
    try {
      const k = fstr(flags, "k") ? Number(fstr(flags, "k")) : 10;
      const diag = { corpusSize: 0, graphNodes: 0 };
      const files = rankFiles(store, query, { k, diag });
      if (flags["json"]) return out(JSON.stringify(files, null, 2));
      if (!files.length) {
        if (diag.corpusSize === 0 && diag.graphNodes === 0) {
          out(c.dim("No relevant files — empty corpus and no code index. Run `cairn sync --full` to backfill git history, or `cairn index` to build the code graph."));
        } else if (diag.corpusSize === 0) {
          out(c.dim("No relevant files — code indexed but git history is empty. Run `cairn sync --full` to backfill history."));
        } else {
          out(c.dim("No matches for that query."));
        }
        return;
      }
      out(c.bold(`\n  Relevant files for ${c.cyan(`"${query}"`)}`));
      out("");
      const maxLen = Math.max(...files.map((f) => f.path.length));
      for (const f of files) {
        out(`  ${c.green(f.score.toFixed(3))}  ${f.path.padEnd(maxLen)}  ${c.dim(f.why.slice(0, 48))}`);
      }
      out("");
    } finally { store.close(); }
  },

  chat(rest, flags) {
    const verb = rest[0];
    const root = requireRoot();
    const actor = actorOf(flags);
    const store = openStore();
    const room = store.projectId;
    const myTeam = getActiveTeam(root, actor);
    try {
      switch (verb) {
        case "send": {
          const body = (fstr(flags, "body") ?? rest.slice(1).join(" ")).trim();
          if (!body) throw new Error('chat send requires --body "<message>"');
          const to = fstr(flags, "to");
          const team = fstr(flags, "team") ?? myTeam;
          const m = sendMessage(store.db, {
            room, sender: actor, body,
            ...(to ? { to } : {}),
            ...(team ? { team } : {}),
          });
          if (flags["json"]) return out(JSON.stringify(m, null, 2));
          out(c.dim(`→ sent ${c.cyan(m.id.slice(-6))}${to ? ` to ${to}` : " (broadcast)"}`));
          return;
        }
        case "inbox": {
          const cooldownMs = fstr(flags, "cooldown") ? Number(fstr(flags, "cooldown")) : 0;
          if (cooldownMs > 0 && !inboxCooldownOk(root, actor, cooldownMs)) return;
          const msgs = inbox(store.db, { room, actor, ...(myTeam ? { team: myTeam } : {}) });
          if (flags["json"]) return out(JSON.stringify(msgs, null, 2));
          if (!msgs.length) return out(c.dim("No new messages."));
          for (const m of msgs) {
            const tag = m.recipient && m.recipient !== actor ? ` @${m.recipient}` : "";
            out(`${c.cyan(m.sender)}${c.dim(tag)}: ${m.body}`);
          }
          return;
        }
        case "tail": {
          const raw = fstr(flags, "interval");
          const parsed = raw ? Number(raw) : 2000;
          const intervalMs = Number.isFinite(parsed) && parsed > 0 ? parsed : 2000;
          out(c.dim(`tailing chat as ${actor}${myTeam ? ` (${myTeam})` : ""} — Ctrl-C to stop`));
          const tick = () => {
            const msgs = inbox(store.db, { room, actor, ...(myTeam ? { team: myTeam } : {}) });
            for (const m of msgs) out(`${c.cyan(m.sender)}: ${m.body}`);
          };
          return new Promise<void>((resolve) => {
            const timer = setInterval(tick, intervalMs);
            const stop = () => {
              clearInterval(timer);
              process.removeListener("SIGINT", stop);
              process.removeListener("SIGTERM", stop);
              store.close();
              resolve();
            };
            process.on("SIGINT", stop);
            process.on("SIGTERM", stop);
          });
        }
        case "history": {
          const rawLimit = fstr(flags, "limit");
          const parsedLimit = rawLimit ? Number(rawLimit) : 50;
          const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 50;
          const team = fstr(flags, "team") ?? myTeam;
          const msgs = history(store.db, { room, limit, ...(team ? { team } : {}) });
          if (flags["json"]) return out(JSON.stringify(msgs, null, 2));
          for (const m of msgs) out(`${c.dim(new Date(m.ts).toLocaleTimeString())} ${c.cyan(m.sender)}: ${m.body}`);
          return;
        }
        case "teams": {
          const tagged = listTeams(store.db, room);
          const joined = listMembershipTeams(root);
          const teams = [...new Set([...tagged, ...joined])].sort();
          if (flags["json"]) return out(JSON.stringify(teams, null, 2));
          out(teams.length ? teams.map((t) => `  ${t}`).join("\n") : c.dim("No teams yet."));
          return;
        }
        case "join": {
          const team = rest[1];
          if (!team) throw new Error("chat join requires a team name, e.g. cairn chat join frontend");
          setActiveTeam(root, actor, team);
          out(c.green(`✔ ${actor} now acting as team ${c.cyan(team)}`));
          return;
        }
        case "leave": {
          clearActiveTeam(root, actor);
          out(c.dim(`${actor} left their team`));
          return;
        }
        default:
          throw new Error("chat <verb>: send | inbox | tail | history | teams | join | leave");
      }
    } finally {
      if (verb !== "tail") store.close();
    }
  },

  recall(_rest, flags) {
    const r = requireRoot();
    const store = openStore();
    try {
      const driftCommits = gitDrift(store, r); // commits since the journal last synced
      const ctx = writeContextFile(store, r, { driftCommits }); // refresh + return
      out(flags["json"] ? JSON.stringify(ctx, null, 2) : renderRecall(ctx, { driftCommits }));
    } finally { store.close(); }
  },

  sync(_rest, flags) {
    const r = requireRoot();
    const store = openStore();
    try {
      const res = syncGit(store, r, {
        full: Boolean(flags["full"]),
        extractIntent: !flags["no-extract"],
      });
      // Re-index after capturing commits so the code graph tracks the new code.
      // Idempotent per content (hashed event id) → only changed files append.
      if (res.events && !flags["no-index"]) {
        const idx = indexRepo(r, { actor: actorOf(flags) });
        if (idx.events.length) store.batchAppend(idx.events);
      }
      writeContextFile(store, r); // keep instant-recall file current
      // Self-healing rules: if the installed cairn carries newer rule text than
      // what's stamped in this repo's agent files, rewrite them now. Runs on
      // every commit (the post-commit hook calls sync), so a package update
      // propagates without the user re-running setup.
      const refreshed = [...refreshProjectRules(r), ...refreshGlobalRules()];
      if (flags["json"]) return out(JSON.stringify({ ...res, rulesRefreshed: refreshed }, null, 2));
      if (!res.synced) return out(c.yellow("⚠ Not a git repo — nothing to sync."));
      if (refreshed.length) out(c.dim(`  refreshed Cairn rules in ${refreshed.length} file(s)`));
      if (res.events) {
        out(c.green(`✔ Captured ${res.commits} commit(s) → ${res.events} event(s) from git`));
        if (res.decisions) out(c.dim(`  extracted ${res.decisions} decision(s) from commit messages`));
      } else {
        out(c.dim(res.toCommit && !res.fromCommit
          ? "Baseline set at HEAD — future commits will be captured automatically."
          : "Already up to date with git."));
      }
    } finally { store.close(); }
  },

  snapshot(_rest, _flags) {
    const journal = new AgentJournal({ actor: "cairn" });
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
    err(c.dim("Run `cairn --help` for usage."));
    return 1;
  }
  try {
    await handler(positionals.slice(1), flags);
    // One-line "newer cairn available" nudge — skipped for machine-readable
    // output and the long-running MCP server; bounded by a 2s cached check.
    if (cmd !== "mcp" && cmd !== "upgrade" && !flags["json"]) {
      await notifyIfUpdate(VERSION);
    }
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  } catch (e) {
    err(c.red(`✖ ${(e as Error).message}`));
    return 1;
  }
}
