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
  requireProjectRoot,
  findProjectRoot,
  type TaskPriority,
} from "../core/index.js";

const VERSION = "0.1.0";

// --- Tiny ANSI styling (no dependencies) -------------------------------------

const useColor =
  process.stdout.isTTY && process.env["NO_COLOR"] === undefined;
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

  snapshot                     Write a restore point to .stated/snapshots/
  doctor                       Validate .stated/ integrity
  mcp                          Start the MCP server (stdio) for AI clients

${c.bold("GLOBAL FLAGS")}
  --agent <name>   Attribute the action to an agent (or set STATED_AGENT)
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
      state.frameworks.length ? state.frameworks.join(", ") : c.dim("(none detected)")
    }`,
  );
  out("");
  out(c.bold("  Active Tasks"));
  if (state.activeTasks.length) {
    for (const t of state.activeTasks) {
      const color = STATUS_COLOR[t.status] ?? ((s: string) => s);
      const owner = t.owner ? c.dim(` @${t.owner}`) : "";
      out(
        `    ${color(`[${t.status}]`.padEnd(11))} ${t.title} ${c.gray(t.id)}${owner}`,
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
      out(`    ${c.yellow("🔒")} ${f.path} ${c.dim(`@${f.owner}`)}`);
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
    out(c.dim("  Next: stated agent register \"Claude Code\""));
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

  goal(rest, flags) {
    const sub = rest[0];
    if (sub === "add") {
      const text = need(rest, 1, "goal text");
      const goals = addGoal(root(), rest.slice(1).join(" ") || text, actor(flags));
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
          },
          actor(flags),
        );
        out(c.green(`✔ Task created: ${t.title} ${c.gray(t.id)}`));
        break;
      }
      case "claim": {
        const id = need(rest, 1, "task id");
        const who = actor(flags);
        if (!who) throw new Error("Provide --agent <name> (or set STATED_AGENT).");
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
        const tasks = readTasks(r);
        if (flags["json"]) return out(JSON.stringify(tasks, null, 2));
        if (!tasks.length) return out(c.dim("(no tasks)"));
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
          ...(flagStr(flags, "reason") ? { reason: flagStr(flags, "reason")! } : {}),
          ...(flagStr(flags, "by") ? { madeBy: flagStr(flags, "by")! } : {}),
        },
        actor(flags),
      );
      out(c.green(`✔ Decision recorded ${c.gray(d.id)}`));
    } else if (sub === "list" || sub === undefined) {
      const ds = readDecisions(root());
      if (flags["json"]) return out(JSON.stringify(ds, null, 2));
      if (!ds.length) return out(c.dim("(no decisions)"));
      for (const d of ds) {
        out(`${c.gray(d.date)}  ${d.decision}${d.reason ? c.dim(` — ${d.reason}`) : ""} ${c.dim(`(${d.madeBy})`)}`);
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
        const dot = live === "active" ? c.green("●") : live === "idle" ? c.yellow("●") : c.gray("●");
        out(`${dot} ${a.name} ${c.dim(`(${a.type}) — ${live}, last seen ${a.lastSeen}`)}`);
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
      if (!who) throw new Error("Provide --agent <name> (or set STATED_AGENT).");
      const f = claimFile(root(), path, who, { force: Boolean(flags["force"]) });
      out(c.green(`✔ ${who} claimed ${f.path}`));
    } else if (sub === "release") {
      const path = need(rest, 1, "file path");
      const removed = releaseFile(root(), path, {
        ...(actor(flags) ? { owner: actor(flags)! } : {}),
        force: Boolean(flags["force"]),
      });
      out(removed ? c.green(`✔ Released ${path}`) : c.yellow(`⚠ No claim on ${path}`));
    } else if (sub === "list" || sub === undefined) {
      const files = readFiles(root());
      if (flags["json"]) return out(JSON.stringify(files, null, 2));
      if (!files.length) return out(c.dim("(no file claims)"));
      for (const f of files) {
        out(`${f.locked ? c.yellow("🔒") : "  "} ${f.path} ${c.dim(`@${f.owner}`)}`);
      }
    } else {
      throw new Error(`Unknown file subcommand: ${sub}`);
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
        f.level === "ok" ? c.green("✔") : f.level === "warn" ? c.yellow("⚠") : c.red("✖");
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
export async function run(argv: string[] = process.argv.slice(2)): Promise<number> {
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
