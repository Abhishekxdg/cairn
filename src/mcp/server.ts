import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { EventStore } from "../core/store.js";
import { agentPaths, requireRoot } from "../core/paths.js";
import { deriveState, activeTasks, activeDecisions } from "../engines/state.js";
import { compileContext, type ContextLevel } from "../engines/context.js";
import { rankFiles, compileTaskContext } from "../engines/relevance.js";
import { deriveTimeline, deriveMemory } from "../engines/memory.js";
import { createSnapshot } from "../engines/snapshots.js";
import { setupProject } from "../setup/install.js";

/**
 * Cairn MCP server.
 *
 * Exposes the journal as MCP tools so any client (Claude Code, Codex, Cursor,
 * OpenHands) can append events and read derived projections from the same
 * source of truth. Operates on the project at `CAIRN_ROOT` (env) or the cwd.
 */

const PKG_VERSION = "0.1.2";

function resolveRoot(): string {
  return process.env["CAIRN_ROOT"] ?? requireRoot();
}
function openStore(): EventStore {
  return new EventStore(agentPaths(resolveRoot()).db);
}
const text = (v: string) => ({ content: [{ type: "text" as const, text: v }] });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const errResult = (e: unknown) =>
  text(`Cairn error: ${(e as Error).message}`) as never;

/**
 * Open the store, run `fn`, and always close. Any failure (e.g. an uninitialized
 * repo where `requireRoot` throws, or `setup_project` hasn't been run) becomes a
 * structured tool-result error the calling agent can read — never a raw,
 * unhandled MCP protocol error.
 */
function withStore<T>(fn: (s: EventStore) => T): T {
  let s: EventStore;
  try {
    s = openStore();
  } catch (e) {
    return errResult(e);
  }
  try {
    return fn(s);
  } catch (e) {
    return errResult(e);
  } finally {
    s.close();
  }
}

/** Build (but do not start) the Cairn MCP server. */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: "cairn", version: PKG_VERSION },
    {
      instructions:
        "Cairn: the append-only source of truth for this " +
        "project. Everything (state, tasks, decisions, memory, context) is " +
        "derived from events. At session start call `register_agent` and " +
        "`query_context` to load context cheaply. Record what you do as events " +
        "with `append_event` (e.g. task.created, decision.made, file.modified) " +
        "so other agents can derive state. Read with `query_state`, " +
        "`query_timeline`, `query_memory`, `get_active_tasks`, " +
        "`get_active_decisions`.",
    },
  );

  server.tool(
    "setup_project",
    "Initialize Cairn in the current project (create the `.agent/` journal and " +
      "teach the coding agents). Run this first when the journal does not exist " +
      "yet — every other tool needs it. Idempotent.",
    {},
    async () => {
      try {
        const root = process.env["CAIRN_ROOT"] ?? process.cwd();
        return json(setupProject(root));
      } catch (e) {
        return text(`Cairn error: ${(e as Error).message}`);
      }
    },
  );

  server.tool(
    "append_event",
    "Append an immutable event to the journal — the only way to change state. " +
      "Use canonical types (task.created, task.completed, decision.made, " +
      "file.modified, knowledge.learned, agent.heartbeat, …) or any custom.* type.",
    {
      type: z.string().describe("Event type, e.g. 'decision.made'"),
      payload: z.record(z.any()).optional().describe("Structured event data"),
      actor: z.string().optional().describe("Who is producing the event"),
      sessionId: z.string().optional().describe("Session/run scope"),
      id: z.string().optional().describe("Explicit id for idempotency"),
    },
    async ({ type, payload, actor, sessionId, id }) =>
      withStore((s) =>
        json(
          s.appendEvent({
            type,
            ...(payload ? { payload } : {}),
            ...(actor ? { actor } : {}),
            ...(sessionId ? { sessionId } : {}),
            ...(id ? { id } : {}),
          }),
        ),
      ),
  );

  server.tool(
    "query_state",
    "Return the full derived state (goals, tasks, decisions, agents, ownership, " +
      "knowledge) folded from the journal.",
    {},
    async () => withStore((s) => json(deriveState(s))),
  );

  server.tool(
    "query_context",
    "Compile the minimum-token useful context to prime an agent. Levels: " +
      "small | medium | large | full. Pass `task` to scope it: the result then " +
      "also carries the files the task most likely touches and the related " +
      "decisions/knowledge — read those files instead of the whole repo.",
    {
      level: z
        .enum(["small", "medium", "large", "full"])
        .optional()
        .describe("Context detail level (default medium)"),
      task: z
        .string()
        .optional()
        .describe("Task description to scope context to relevant files"),
    },
    async ({ level, task }) =>
      withStore((s) =>
        json(
          task
            ? compileTaskContext(s, task, { level: (level ?? "medium") as ContextLevel })
            : compileContext(s, { level: (level ?? "medium") as ContextLevel }),
        ),
      ),
  );

  server.tool(
    "relevant_files",
    "Given a task description, return the ranked set of files the task most " +
      "likely needs — mined from commit history (intent → files). Read these " +
      "instead of the whole repo. Deterministic; no embeddings.",
    {
      query: z.string().describe("Task description, e.g. 'add payment retries'"),
      k: z.number().int().optional().describe("How many files to return (default 10)"),
    },
    async ({ query, k }) =>
      withStore((s) => json(rankFiles(s, query, k !== undefined ? { k } : {}))),
  );

  server.tool(
    "query_memory",
    "Return derived memory entries recorded in the journal.",
    {},
    async () => withStore((s) => json(deriveMemory(s))),
  );

  server.tool(
    "query_timeline",
    "Return a human-readable, day-grouped timeline of what happened.",
    {
      sinceSeq: z.number().int().optional().describe("Only events after this seq"),
      type: z.string().optional().describe("Restrict to one event type"),
    },
    async ({ sinceSeq, type }) =>
      withStore((s) =>
        json(
          deriveTimeline(s, {
            ...(sinceSeq !== undefined ? { sinceSeq } : {}),
            ...(type ? { types: [type] } : {}),
          }),
        ),
      ),
  );

  server.tool(
    "register_agent",
    "Register the calling agent (records an agent.registered event).",
    {
      name: z.string().describe("Agent display name"),
      type: z.string().optional().describe("Agent kind"),
      capabilities: z.array(z.string()).optional(),
    },
    async ({ name, type, capabilities }) =>
      withStore((s) =>
        json(
          s.appendEvent({
            type: "agent.registered",
            actor: name,
            payload: {
              name,
              ...(type ? { type } : {}),
              ...(capabilities ? { capabilities } : {}),
            },
          }),
        ),
      ),
  );

  server.tool(
    "create_snapshot",
    "Force a state snapshot (optimization; rebuildable from events).",
    {},
    async () =>
      withStore((s) => json({ ok: true, seq: createSnapshot(s, deriveState(s)).seq })),
  );

  server.tool(
    "get_active_tasks",
    "Return the currently active (non-completed, non-archived) tasks.",
    {},
    async () => withStore((s) => json(activeTasks(deriveState(s)))),
  );

  server.tool(
    "get_active_decisions",
    "Return the decisions currently in force (status = active).",
    {},
    async () => withStore((s) => json(activeDecisions(deriveState(s)))),
  );

  // Read-only resources.
  server.resource(
    "state",
    "cairn://state",
    { mimeType: "application/json", description: "Derived project state" },
    async (uri) => withStore((s) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(deriveState(s), null, 2) }],
    })),
  );
  server.resource(
    "context",
    "cairn://context",
    { mimeType: "application/json", description: "Compiled medium context" },
    async (uri) => withStore((s) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(compileContext(s, { level: "medium" }), null, 2) }],
    })),
  );

  return server;
}

/** Start the server over stdio. */
export async function startStdioServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("cairn MCP server running on stdio\n");
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  startStdioServer().catch((e) => {
    process.stderr.write(`cairn MCP server failed: ${e}\n`);
    process.exit(1);
  });
}
