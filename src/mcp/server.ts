import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  init,
  isInitialized,
  findProjectRoot,
  requireProjectRoot,
  buildState,
  generateHandoff,
  createSnapshot,
  registerAgent,
  addTask,
  claimTask,
  completeTask,
  startTask,
  addDecision,
  claimFile,
  releaseFile,
  verifyTask,
  verifyFile,
  getTask,
  fileOwner,
  applyDecay,
  readTasks,
  readAgents,
  searchProject,
  type TaskPriority,
  type SearchType,
} from "../core/index.js";

/**
 * Stated MCP server.
 *
 * Exposes the shared project state as MCP tools and resources so any
 * MCP-compatible client (Claude Code, Codex, Cursor, OpenHands, ...) can read
 * and update the same `.stated/` brain. The server operates on the project at
 * `STATED_ROOT` (env) or the current working directory.
 */

const PKG_VERSION = "0.1.0";

/** Resolve the project root for tool calls, falling back to cwd discovery. */
function resolveRoot(): string {
  const env = process.env["STATED_ROOT"];
  if (env) return env;
  return requireProjectRoot();
}

/** Wrap a string payload as an MCP text content result. */
function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

/** Wrap a JSON-serializable payload as a pretty text result. */
function json(value: unknown) {
  return text(JSON.stringify(value, null, 2));
}

/** Build (but do not start) the Stated MCP server instance. */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: "stated", version: PKG_VERSION },
    {
      instructions:
        "Stated is the shared project brain stored in `.stated/`. " +
        "At the start of a session call `get_handoff` (or `get_state`) to load " +
        "context in one read. Register yourself with `register_agent`. Before " +
        "editing a file, `claim_file` it; release it when done. Record durable " +
        "choices with `create_decision`. Track work with `create_task` / " +
        "`claim_task` / `complete_task` so other agents never duplicate effort.",
    },
  );

  // --- init ------------------------------------------------------------------
  server.tool(
    "init_project",
    "Initialize a .stated/ shared-state directory in the current project. " +
      "Safe to call if already initialized (returns the existing root unless force).",
    {
      name: z.string().optional().describe("Project name (defaults to dir name)"),
      description: z.string().optional().describe("Short project description"),
      force: z.boolean().optional().describe("Reinitialize scaffolding"),
    },
    async ({ name, description, force }) => {
      const cwd = process.env["STATED_ROOT"] ?? process.cwd();
      if (isInitialized(cwd) && !force) {
        return json({ ok: true, root: findProjectRoot(cwd), alreadyInitialized: true });
      }
      const res = init(cwd, {
        ...(name ? { name } : {}),
        ...(description ? { description } : {}),
        ...(force ? { force } : {}),
      });
      return json({ ok: true, ...res });
    },
  );

  // --- register_agent --------------------------------------------------------
  server.tool(
    "register_agent",
    "Register the calling agent (or refresh its heartbeat) so other agents can " +
      "see who is active. Call this once at the start of a session.",
    {
      name: z.string().describe("Agent display name, e.g. 'Claude Code'"),
      type: z
        .enum(["claude", "codex", "cursor", "openhands", "human", "other"])
        .optional()
        .describe("Agent kind (inferred from the name if omitted)"),
    },
    async ({ name, type }) => json(registerAgent(resolveRoot(), name, type)),
  );

  // --- get_state -------------------------------------------------------------
  server.tool(
    "get_state",
    "Return the compact machine-readable project state: goal, active tasks, " +
      "recent decisions, active agents, locked files and detected frameworks. " +
      "The fastest way to prime context.",
    {},
    async () => json(buildState(resolveRoot())),
  );

  // --- get_handoff -----------------------------------------------------------
  server.tool(
    "get_handoff",
    "Return the human/AI-readable handoff document summarizing the project: " +
      "goal, current work, decisions, agents, locked files and next steps.",
    {},
    async () => text(generateHandoff(resolveRoot())),
  );

  // --- search_memory ---------------------------------------------------------
  server.tool(
    "search_memory",
    "Keyword-search the project brain (tasks, decisions, goals) with BM25 and " +
      "return ranked hits. Use this to pull just the relevant context instead " +
      "of loading the whole handoff. No embeddings — deterministic results.",
    {
      query: z.string().describe("Search query (keywords)"),
      type: z
        .enum(["task", "decision", "goal"])
        .optional()
        .describe("Restrict results to one document type"),
      limit: z.number().int().positive().optional().describe("Max hits (default 10)"),
      run_id: z.string().optional().describe("Restrict results to one session/run scope"),
    },
    async ({ query, type, limit, run_id }) =>
      json(
        searchProject(resolveRoot(), query, {
          ...(type ? { type: type as SearchType } : {}),
          ...(limit ? { limit } : {}),
          ...(run_id ? { run: run_id } : {}),
        }),
      ),
  );

  // --- generate_handoff (explicit regenerate) --------------------------------
  server.tool(
    "generate_handoff",
    "Force-regenerate handoff.md and state.json from the canonical files and " +
      "return the fresh handoff text.",
    {},
    async () => text(generateHandoff(resolveRoot())),
  );

  // --- create_task -----------------------------------------------------------
  server.tool(
    "create_task",
    "Create a new task on the shared board so other agents don't duplicate it.",
    {
      title: z.string().describe("Short task title"),
      description: z.string().optional().describe("Optional details"),
      priority: z
        .enum(["low", "medium", "high", "critical"])
        .optional()
        .describe("Task priority (default: medium)"),
      owner: z.string().optional().describe("Initial owner (claims the task)"),
      run_id: z.string().optional().describe("Session/run scope for this task"),
      actor: z.string().optional().describe("Acting agent name"),
    },
    async ({ title, description, priority, owner, run_id, actor }) =>
      json(
        addTask(
          resolveRoot(),
          {
            title,
            ...(description ? { description } : {}),
            ...(priority ? { priority: priority as TaskPriority } : {}),
            ...(owner ? { owner } : {}),
            ...(run_id ? { runId: run_id } : {}),
          },
          actor,
        ),
      ),
  );

  // --- claim_task ------------------------------------------------------------
  server.tool(
    "claim_task",
    "Claim a task for an agent so others avoid working on it. Fails if owned by " +
      "another agent unless force is set.",
    {
      id: z.string().describe("Task id, e.g. t_a1b2c3d4"),
      owner: z.string().describe("Agent claiming the task"),
      force: z.boolean().optional().describe("Override an existing owner"),
    },
    async ({ id, owner, force }) =>
      json(claimTask(resolveRoot(), id, owner, force ? { force } : {})),
  );

  // --- start_task ------------------------------------------------------------
  server.tool(
    "start_task",
    "Mark a task as actively in progress.",
    {
      id: z.string().describe("Task id"),
      actor: z.string().optional().describe("Acting agent name"),
    },
    async ({ id, actor }) => json(startTask(resolveRoot(), id, actor)),
  );

  // --- complete_task ---------------------------------------------------------
  server.tool(
    "complete_task",
    "Mark a task completed. Triggers regeneration of the handoff and state.",
    {
      id: z.string().describe("Task id"),
      actor: z.string().optional().describe("Acting agent name"),
    },
    async ({ id, actor }) => json(completeTask(resolveRoot(), id, actor)),
  );

  // --- create_decision -------------------------------------------------------
  server.tool(
    "create_decision",
    "Record a durable project decision (with reason) so it is never lost or " +
      "re-litigated by a future agent.",
    {
      decision: z.string().describe("The decision, e.g. 'Use BullMQ'"),
      reason: z.string().optional().describe("Why, e.g. 'Reliable retries'"),
      madeBy: z.string().optional().describe("Who made the decision"),
      run_id: z.string().optional().describe("Session/run scope for this decision"),
      actor: z.string().optional().describe("Acting agent name"),
    },
    async ({ decision, reason, madeBy, run_id, actor }) =>
      json(
        addDecision(
          resolveRoot(),
          {
            decision,
            ...(reason ? { reason } : {}),
            ...(madeBy ? { madeBy } : {}),
            ...(run_id ? { runId: run_id } : {}),
          },
          actor,
        ),
      ),
  );

  // --- claim_file ------------------------------------------------------------
  server.tool(
    "claim_file",
    "Claim/lock a file before editing it so other agents avoid a conflicting " +
      "edit. Fails if locked by another agent unless force is set.",
    {
      path: z.string().describe("Repo-relative file path"),
      owner: z.string().describe("Agent claiming the file"),
      lock: z.boolean().optional().describe("Whether to hard-lock (default true)"),
      force: z.boolean().optional().describe("Override an existing lock"),
    },
    async ({ path, owner, lock, force }) =>
      json(
        claimFile(resolveRoot(), path, owner, {
          ...(lock !== undefined ? { lock } : {}),
          ...(force ? { force } : {}),
        }),
      ),
  );

  // --- release_file ----------------------------------------------------------
  server.tool(
    "release_file",
    "Release a previously claimed file.",
    {
      path: z.string().describe("Repo-relative file path"),
      owner: z.string().optional().describe("Agent releasing the file"),
      force: z.boolean().optional().describe("Override another owner's lock"),
    },
    async ({ path, owner, force }) => {
      const removed = releaseFile(resolveRoot(), path, {
        ...(owner ? { owner } : {}),
        ...(force ? { force } : {}),
      });
      return json({ ok: true, released: removed, path });
    },
  );

  // --- verify_fact -----------------------------------------------------------
  server.tool(
    "verify_fact",
    "Re-confirm a task or file lock is still accurate WITHOUT changing it. " +
      "Resets its staleness clock so the shared state stops showing it as " +
      "decaying. Use this when you've checked something is still current.",
    {
      idOrPath: z.string().describe("Task id (t_…) or repo-relative file path"),
      actor: z.string().optional().describe("Acting agent name"),
    },
    async ({ idOrPath, actor }) => {
      const root = resolveRoot();
      if (getTask(root, idOrPath)) {
        return json({ ok: true, kind: "task", fact: verifyTask(root, idOrPath, actor) });
      }
      if (fileOwner(root, idOrPath)) {
        return json({ ok: true, kind: "file", fact: verifyFile(root, idOrPath, actor) });
      }
      return json({ ok: false, error: `No task or file claim matching "${idOrPath}".` });
    },
  );

  // --- run_decay -------------------------------------------------------------
  server.tool(
    "run_decay",
    "Run the project's customizable memory-decay policy: release abandoned " +
      "locks, archive long-completed tasks, trim the event log. Dry run by " +
      "default (returns the proposed actions); pass apply:true to perform them. " +
      "All policies are off unless enabled in .stated/config.json.",
    {
      apply: z
        .boolean()
        .optional()
        .describe("Perform the actions (default false = dry run)"),
    },
    async ({ apply }) => json(applyDecay(resolveRoot(), { apply: Boolean(apply) })),
  );

  // --- snapshot --------------------------------------------------------------
  server.tool(
    "create_snapshot",
    "Write a timestamped restore point of the project state to .stated/snapshots/.",
    {},
    async () => json({ ok: true, dir: createSnapshot(resolveRoot()) }),
  );

  // --- read-only resources ---------------------------------------------------
  server.resource(
    "handoff",
    "stated://handoff",
    { mimeType: "text/markdown", description: "Current project handoff" },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: generateHandoff(resolveRoot()),
        },
      ],
    }),
  );

  server.resource(
    "state",
    "stated://state",
    { mimeType: "application/json", description: "Compact machine state" },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(buildState(resolveRoot()), null, 2),
        },
      ],
    }),
  );

  server.resource(
    "tasks",
    "stated://tasks",
    { mimeType: "application/json", description: "All tasks" },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(readTasks(resolveRoot()), null, 2),
        },
      ],
    }),
  );

  server.resource(
    "agents",
    "stated://agents",
    { mimeType: "application/json", description: "Registered agents" },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(readAgents(resolveRoot()), null, 2),
        },
      ],
    }),
  );

  return server;
}

/** Start the server over stdio. Used by the `stated-mcp` binary. */
export async function startStdioServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr so we never corrupt the stdio JSON-RPC stream.
  process.stderr.write("stated MCP server running on stdio\n");
}

// Allow `node dist/mcp/server.js` to launch the server directly.
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  startStdioServer().catch((err) => {
    process.stderr.write(`stated MCP server failed: ${err}\n`);
    process.exit(1);
  });
}
