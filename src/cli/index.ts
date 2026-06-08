import {
  init,
  buildState,
  generateHandoff,
  createSnapshot,
  doctor,
  readProject,
  readGoals,
  addGoal,
  completeGoal,
  readTasks,
  addTask,
  claimTask,
  startTask,
  completeTask,
  blockTask,
  readDecisions,
  addDecision,
  readAgents,
  registerAgent,
  liveStatus,
  readFiles,
  claimFile,
  releaseFile,
  verifyTask,
  verifyFile,
  getTask,
  fileOwner,
  applyDecay,
  syncProject,
  ageLabel,
  type Confidence,
  searchProject,
  type SearchType,
  requireProjectRoot,
  findProjectRoot,
  type TaskPriority,
} from "../core/index.js";

/** Resolve the active session/run scope from flag or env. */
function runScope(flags: Parsed["flags"]): string | undefined {
  return flagStr(flags, "run") ?? process.env["STATED_RUN"] ?? undefined;
}

const VERSION = "0.1.0";

// --- Tiny ANSI styling (no dependencies) -------------------------------------

const useColor = process.stdout.isTTY && process.env["NO_COLOR"] === undefined;
const wrap = (code: string) => (s: string) =>
  useColor ? `[${code}m${s}[0m` : s;
const c = {
  bold: wrap("1"),
  dim: wrap("2"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  cyan: wrap("36"),
  gray: wrap("90"),
};

function out(s = ""): void {
  process.stdout.write(s + "\n");
}
function err(s = ""): void {
  process.stderr.write(s + "\n");
}

// --- Argument parsing ---------------------------------------------------------

interface Parsed {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parse(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const eq = key.indexOf("=");
      if (eq !== -1) {
        flags[key.slice(0, eq)] = key.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

function flagStr(flags: Parsed["flags"], key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

/** Resolve the acting agent from flag, env, or undefined. */
function actor(flags: Parsed["flags"]): string | undefined {
  return flagStr(flags, "agent") ?? process.env["STATED_AGENT"] ?? undefined;
}

function root(): string {
  return requireProjectRoot();
}

// --- Help ---------------------------------------------------------------------

const HELP = `${c.bold("stated")} — shared state layer for AI coding agents

${c.bold("USAGE")}
  stated <command> [args] [--flags]

${c.bold("COMMANDS")}
  init                         Create .stated/ in the current directory
  status                       Show the current shared project state
  state                        Print machine-readable state.json
  handoff                      Generate & print handoff.md
  search <query>               Keyword-search tasks, decisions & goals (BM25; --run)

  goal add <text>              Add an active goal
  goal complete <query>        Mark a matching active goal completed
  goal list                    List goals

  task add <title>             Create a task
  task list                    List tasks
  task claim <id>              Claim a task (--agent <name>)
  task start <id>              Mark a task active
  task complete <id>           Mark a task completed
  task block <id>              Mark a task blocked (--reason <text>)

  decision add <text>          Record a decision (--reason, --by)

  agent register <name>        Register/heartbeat an agent
  agent list                   List agents

  file claim <path>            Claim/lock a file (--agent <name>)
  file release <path>          Release a file
  file list                    List file ownership

  verify <id|path>             Re-confirm a task/lock is still true (resets decay)
  sync                         Reconcile Stated claims with git (proposes only)
  decay [--apply]              Run memory-decay policy (dry run unless --apply)

  snapshot                     Write a restore point to .stated/snapshots/
  doctor                       Validate .stated/ integrity
  mcp                          Start the MCP server (stdio) for AI clients

${c.bold("GLOBAL FLAGS")}
  --agent <name>   Attribute the action to an agent (or set STATED_AGENT)
  --run <id>       Scope tasks/decisions to a session/run (or set STATED_RUN)
  --json           Emit JSON instead of formatted text
  --force          Override locks / reinitialize
  --version, -v    Print version
  --help, -h       Print this help

${c.bold("EXAMPLE")}
  stated init
  stated agent register "Claude Code"
  stated task add "Build OAuth" --priority high
  stated handoff
`;

// --- Rendering helpers --------------------------------------------------------

const STATUS_COLOR: Record<string, (s: string) => string> = {
  todo: c.gray,
  claimed: c.yellow,
  active: c.cyan,
  blocked: c.red,
  completed: c.green,
};

/** Colorize text by confidence: stale=red, aging=yellow, fresh=unchanged. */
function confColor(conf: Confidence): (s: string) => string {
  if (conf === "stale") return c.red;
  if (conf === "aging") return c.yellow;
  return (s: string) => s;
}

/** A short " ⚠ stale (3 weeks)" suffix, dimmed; empty when fresh. */
function ageSuffix(conf: Confidence, ageMs: number): string {
  if (conf === "fresh") return "";
  const label = conf === "stale" ? "⚠ stale" : "aging";
  return ` ${confColor(conf)(label)} ${c.dim(`(${ageLabel(ageMs)})`)}`;
}

function renderStatus(flags: Parsed["flags"]): void {
  const r = root();
  const state = buildState(r);
  if (flags["json"]) {
    out(JSON.stringify(state, null, 2));
    return;
  }
  out(c.bold(`\n  ${state.project.name || "(unnamed project)"}`));
  if (state.project.description) out(c.dim(`  ${state.project.description}`));
  out("");
  out(`  ${c.bold("Goal")}        ${state.goal || c.dim("(none)")}`);
  out(
    `  ${c.bold("Frameworks")}  ${
      state.frameworks.length
        ? state.frameworks.join(", ")
        : c.dim("(none detected)")
    }`,
  );
  // Freshness banner.
  const fr = state.freshness;
  const frText =
    fr.counts.stale === 0 && fr.counts.aging === 0
      ? c.green("✓ all fresh")
      : `${fr.counts.stale ? c.red(`⚠ ${fr.counts.stale} stale`) : ""}${
          fr.counts.stale && fr.counts.aging ? ", " : ""
        }${fr.counts.aging ? c.yellow(`${fr.counts.aging} aging`) : ""}`;
  out(`  ${c.bold("Freshness")}   ${frText}`);
  out("");
  out(c.bold("  Active Tasks"));
  if (state.activeTasks.length) {
    for (const t of state.activeTasks) {
      const color = STATUS_COLOR[t.status] ?? ((s: string) => s);
      const owner = t.owner ? c.dim(` @${t.owner}`) : "";
      out(
        `    ${color(`[${t.status}]`.padEnd(11))} ${t.title} ${c.gray(t.id)}${owner}${ageSuffix(t.confidence, t.ageMs)}`,
      );
    }
  } else {
    out(c.dim("    (none)"));
  }
  out("");
  out(c.bold("  Active Agents"));
  if (state.activeAgents.length) {
    for (const a of state.activeAgents) {
      out(`    ${c.green("●")} ${a.name} ${c.dim(`(${a.type})`)}`);
    }
  } else {
    out(c.dim("    (none)"));
  }
  if (state.lockedFiles.length) {
    out("");
    out(c.bold("  Locked Files"));
    for (const f of state.lockedFiles) {
      out(
        `    ${c.yellow("🔒")} ${f.path} ${c.dim(`@${f.owner}`)}${ageSuffix(f.confidence, f.ageMs)}`,
      );
    }
  }
  if (state.recentDecisions.length) {
    out("");
    out(c.bold("  Recent Decisions"));
    for (const d of state.recentDecisions.slice(0, 3)) {
      out(`    • ${d.decision}${d.reason ? c.dim(` — ${d.reason}`) : ""}`);
    }
  }
  out("");
}

// --- Command handlers ---------------------------------------------------------

type Handler = (rest: string[], flags: Parsed["flags"]) => void | Promise<void>;

function need(rest: string[], i: number, what: string): string {
  const v = rest[i];
  if (v === undefined || v === "") {
    throw new Error(`Missing argument: ${what}`);
  }
  return v;
}

const commands: Record<string, Handler> = {
  init(_rest, flags) {
    const cwd = process.cwd();
    if (findProjectRoot(cwd) && !flags["force"]) {
      out(c.yellow("⚠ .stated/ already exists. Use --force to reinitialize."));
      return;
    }
    const res = init(cwd, {
      ...(flagStr(flags, "name") ? { name: flagStr(flags, "name")! } : {}),
      ...(flagStr(flags, "description")
        ? { description: flagStr(flags, "description")! }
        : {}),
      force: Boolean(flags["force"]),
    });
    out(c.green("✔ Initialized Stated shared state at .stated/"));
    if (res.frameworks.length) {
      out(c.dim(`  Detected: ${res.frameworks.join(", ")}`));
    }
    out(c.dim('  Next: stated agent register "Claude Code"'));
  },

  status: (_rest, flags) => renderStatus(flags),

  state(_rest, flags) {
    void flags;
    out(JSON.stringify(buildState(root()), null, 2));
  },

  handoff(_rest, flags) {
    const text = generateHandoff(root());
    if (flags["json"]) out(JSON.stringify({ handoff: text }, null, 2));
    else out(text);
  },

  search(rest, flags) {
    const query = rest.join(" ").trim();
    if (!query) throw new Error("Missing argument: search query");
    const limit = Number(flagStr(flags, "limit")) || 10;
    const hits = searchProject(root(), query, {
      ...(flagStr(flags, "type")
        ? { type: flagStr(flags, "type") as SearchType }
        : {}),
      ...(runScope(flags) ? { run: runScope(flags)! } : {}),
      limit,
    });
    if (flags["json"]) return out(JSON.stringify(hits, null, 2));
    if (!hits.length) return out(c.dim(`(no matches for "${query}")`));
    const TYPE_COLOR: Record<string, (s: string) => string> = {
      task: c.cyan,
      decision: c.yellow,
      goal: c.green,
    };
    for (const h of hits) {
      const tag = (TYPE_COLOR[h.type] ?? ((s: string) => s))(
        `[${h.type}]`.padEnd(11),
      );
      out(`${tag} ${h.title} ${c.gray(h.id)} ${c.dim(`(${h.score})`)}`);
      out(`            ${c.dim(h.snippet)}`);
    }
  },

  goal(rest, flags) {
    const sub = rest[0];
    if (sub === "add") {
      const text = need(rest, 1, "goal text");
      const goals = addGoal(
        root(),
        rest.slice(1).join(" ") || text,
        actor(flags),
      );
      out(c.green(`✔ Goal added. ${goals.active.length} active.`));
    } else if (sub === "complete" || sub === "done") {
      const q = need(rest, 1, "goal query");
      completeGoal(root(), rest.slice(1).join(" ") || q, actor(flags));
      out(c.green("✔ Goal completed."));
    } else if (sub === "list" || sub === undefined) {
      const g = readGoals(root());
      if (flags["json"]) return out(JSON.stringify(g, null, 2));
      out(c.bold("Active"));
      g.active.forEach((x) => out(`  ${c.cyan("○")} ${x}`));
      if (!g.active.length) out(c.dim("  (none)"));
      out(c.bold("Completed"));
      g.completed.forEach((x) => out(`  ${c.green("✔")} ${x}`));
      if (!g.completed.length) out(c.dim("  (none)"));
    } else {
      throw new Error(`Unknown goal subcommand: ${sub}`);
    }
  },

  task(rest, flags) {
    const sub = rest[0];
    const r = root();
    switch (sub) {
      case "add": {
        const title = rest.slice(1).join(" ").trim();
        if (!title) throw new Error("Missing argument: task title");
        const t = addTask(
          r,
          {
            title,
            ...(flagStr(flags, "description")
              ? { description: flagStr(flags, "description")! }
              : {}),
            priority: (flagStr(flags, "priority") as TaskPriority) ?? "medium",
            ...(actor(flags) && flags["claim"] ? { owner: actor(flags)! } : {}),
            ...(runScope(flags) ? { runId: runScope(flags)! } : {}),
          },
          actor(flags),
        );
        out(c.green(`✔ Task created: ${t.title} ${c.gray(t.id)}`));
        break;
      }
      case "claim": {
        const id = need(rest, 1, "task id");
        const who = actor(flags);
        if (!who)
          throw new Error("Provide --agent <name> (or set STATED_AGENT).");
        const t = claimTask(r, id, who, { force: Boolean(flags["force"]) });
        out(c.green(`✔ ${who} claimed ${t.title} ${c.gray(t.id)}`));
        break;
      }
      case "start": {
        const id = need(rest, 1, "task id");
        const t = startTask(r, id, actor(flags));
        out(c.green(`✔ Started ${t.title} ${c.gray(t.id)}`));
        break;
      }
      case "complete":
      case "done": {
        const id = need(rest, 1, "task id");
        const t = completeTask(r, id, actor(flags));
        out(c.green(`✔ Completed ${t.title} ${c.gray(t.id)}`));
        break;
      }
      case "block": {
        const id = need(rest, 1, "task id");
        const t = blockTask(r, id, flagStr(flags, "reason"), actor(flags));
        out(c.yellow(`⊘ Blocked ${t.title} ${c.gray(t.id)}`));
        break;
      }
      case "list":
      case undefined: {
        const scope = runScope(flags);
        const tasks = readTasks(r).filter((t) => !scope || t.runId === scope);
        if (flags["json"]) return out(JSON.stringify(tasks, null, 2));
        if (!tasks.length) {
          return out(
            c.dim(scope ? `(no tasks in run "${scope}")` : "(no tasks)"),
          );
        }
        for (const t of tasks) {
          const color = STATUS_COLOR[t.status] ?? ((s: string) => s);
          const owner = t.owner ? c.dim(` @${t.owner}`) : "";
          out(
            `${color(`[${t.status}]`.padEnd(11))} ${c.gray(t.id)} ${t.title}${owner} ${c.dim(`(${t.priority})`)}`,
          );
        }
        break;
      }
      default:
        throw new Error(`Unknown task subcommand: ${sub}`);
    }
  },

  decision(rest, flags) {
    const sub = rest[0];
    if (sub === "add") {
      const text = rest.slice(1).join(" ").trim();
      if (!text) throw new Error("Missing argument: decision text");
      const d = addDecision(
        root(),
        {
          decision: text,
          ...(flagStr(flags, "reason")
            ? { reason: flagStr(flags, "reason")! }
            : {}),
          ...(flagStr(flags, "by") ? { madeBy: flagStr(flags, "by")! } : {}),
          ...(flagStr(flags, "supersedes")
            ? { supersedes: flagStr(flags, "supersedes")! }
            : {}),
          ...(runScope(flags) ? { runId: runScope(flags)! } : {}),
        },
        actor(flags),
      );
      out(c.green(`✔ Decision recorded ${c.gray(d.id)}`));
    } else if (sub === "list" || sub === undefined) {
      const scope = runScope(flags);
      const ds = readDecisions(root()).filter(
        (d) => !scope || d.runId === scope,
      );
      if (flags["json"]) return out(JSON.stringify(ds, null, 2));
      if (!ds.length) return out(c.dim("(no decisions)"));
      for (const d of ds) {
        const status =
          d.status === "superseded"
            ? c.dim(` superseded by ${d.supersededBy}`)
            : "";
        out(
          `${c.gray(d.date)}  ${d.decision}${d.reason ? c.dim(` — ${d.reason}`) : ""} ${c.dim(`(${d.madeBy})`)}${status}`,
        );
      }
    } else {
      throw new Error(`Unknown decision subcommand: ${sub}`);
    }
  },

  agent(rest, flags) {
    const sub = rest[0];
    if (sub === "register") {
      const name = rest.slice(1).join(" ").trim() || actor(flags);
      if (!name) throw new Error("Missing argument: agent name");
      const a = registerAgent(root(), name);
      out(c.green(`✔ Registered ${a.name} ${c.dim(`(${a.type})`)}`));
    } else if (sub === "list" || sub === undefined) {
      const agents = readAgents(root());
      if (flags["json"]) return out(JSON.stringify(agents, null, 2));
      if (!agents.length) return out(c.dim("(no agents)"));
      for (const a of agents) {
        const live = liveStatus(a);
        const dot =
          live === "active"
            ? c.green("●")
            : live === "idle"
              ? c.yellow("●")
              : c.gray("●");
        out(
          `${dot} ${a.name} ${c.dim(`(${a.type}) — ${live}, last seen ${a.lastSeen}`)}`,
        );
      }
    } else {
      throw new Error(`Unknown agent subcommand: ${sub}`);
    }
  },

  file(rest, flags) {
    const sub = rest[0];
    if (sub === "claim") {
      const path = need(rest, 1, "file path");
      const who = actor(flags);
      if (!who)
        throw new Error("Provide --agent <name> (or set STATED_AGENT).");
      const f = claimFile(root(), path, who, {
        force: Boolean(flags["force"]),
      });
      out(c.green(`✔ ${who} claimed ${f.path}`));
    } else if (sub === "release") {
      const path = need(rest, 1, "file path");
      const removed = releaseFile(root(), path, {
        ...(actor(flags) ? { owner: actor(flags)! } : {}),
        force: Boolean(flags["force"]),
      });
      out(
        removed
          ? c.green(`✔ Released ${path}`)
          : c.yellow(`⚠ No claim on ${path}`),
      );
    } else if (sub === "list" || sub === undefined) {
      const files = readFiles(root());
      if (flags["json"]) return out(JSON.stringify(files, null, 2));
      if (!files.length) return out(c.dim("(no file claims)"));
      for (const f of files) {
        out(
          `${f.locked ? c.yellow("🔒") : "  "} ${f.path} ${c.dim(`@${f.owner}`)}`,
        );
      }
    } else {
      throw new Error(`Unknown file subcommand: ${sub}`);
    }
  },

  verify(rest, flags) {
    const r = root();
    const idOrPath = need(rest, 0, "task id or file path");
    if (getTask(r, idOrPath)) {
      const t = verifyTask(r, idOrPath, actor(flags));
      out(c.green(`✔ Verified task ${t.title} ${c.gray(t.id)}`));
    } else if (fileOwner(r, idOrPath)) {
      const f = verifyFile(r, idOrPath, actor(flags));
      out(c.green(`✔ Verified lock on ${f.path}`));
    } else {
      throw new Error(`No task or file claim matching "${idOrPath}".`);
    }
  },

  decay(_rest, flags) {
    const r = root();
    const apply = Boolean(flags["apply"]);
    const report = applyDecay(r, { apply });
    if (flags["json"]) return out(JSON.stringify(report, null, 2));
    if (!report.actions.length) {
      out(c.dim("No decay actions. (Enable policies in .stated/config.json.)"));
      return;
    }
    for (const a of report.actions) {
      out(
        `${c.yellow("•")} ${a.kind} ${c.bold(a.target)} ${c.dim(`— ${a.detail}`)}`,
      );
    }
    out("");
    if (apply) {
      out(c.green(`✔ Applied ${report.actions.length} decay action(s).`));
      if (report.archiveDir) out(c.dim(`  Archived to ${report.archiveDir}`));
    } else {
      out(
        c.dim(
          `Dry run — ${report.actions.length} action(s). Re-run with --apply to perform them.`,
        ),
      );
    }
  },

  sync(_rest, flags) {
    const report = syncProject(root(), { actor: actor(flags) });
    if (flags["json"]) return out(JSON.stringify(report, null, 2));
    out(`${c.bold("Branch:")} ${report.branch}`);
    if (report.dirtyFiles.length) {
      out(`${c.bold("Dirty files:")} ${report.dirtyFiles.length}`);
      for (const f of report.dirtyFiles) out(`  ${f}`);
    } else {
      out(`${c.bold("Dirty files:")} none`);
    }
    if (!report.suggestions.length) {
      out(c.green("✔ No sync suggestions."));
      return;
    }
    out(c.yellow("Suggestions:"));
    for (const s of report.suggestions) {
      out(`- ${s.kind} ${c.bold(s.target)} ${c.dim(`— ${s.reason}`)}`);
    }
  },

  snapshot(_rest, _flags) {
    const dir = createSnapshot(root());
    out(c.green(`✔ Snapshot written to ${dir}`));
  },

  async mcp(_rest, _flags) {
    // Lazy-load the MCP server so the CLI stays fast for non-MCP commands.
    const { startStdioServer } = await import("../mcp/server.js");
    await startStdioServer();
    // Keep the process alive; the transport owns the lifecycle.
    await new Promise<never>(() => {});
  },

  doctor(_rest, flags) {
    const report = doctor(root());
    if (flags["json"]) return out(JSON.stringify(report, null, 2));
    for (const f of report.findings) {
      const icon =
        f.level === "ok"
          ? c.green("✔")
          : f.level === "warn"
            ? c.yellow("⚠")
            : c.red("✖");
      out(`${icon} ${f.message}`);
    }
    out("");
    out(report.healthy ? c.green("Healthy.") : c.red("Problems found."));
    if (!report.healthy) process.exitCode = 1;
  },
};

// Aliases.
commands["init"] = commands["init"]!;

/** Main CLI entry point. Returns a process exit code. */
export async function run(
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  const { positionals, flags } = parse(argv);
  const cmd = positionals[0];

  if (flags["version"] || flags["v"] || cmd === "version") {
    out(VERSION);
    return 0;
  }
  if (!cmd || flags["help"] || flags["h"] || cmd === "help") {
    out(HELP);
    return 0;
  }

  const handler = commands[cmd];
  if (!handler) {
    err(c.red(`Unknown command: ${cmd}`));
    err(c.dim("Run `stated --help` for usage."));
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
