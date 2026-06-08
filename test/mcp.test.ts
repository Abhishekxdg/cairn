import { describe, it, expect, afterAll, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { join } from "node:path";
import { init } from "../src/core/manifest.js";
import { createServer } from "../src/mcp/server.js";
import { tempDir, cleanupAll } from "./helpers.js";

afterAll(cleanupAll);

let prev: string | undefined;
beforeEach(() => {
  prev = process.env["CAIRN_ROOT"];
});
afterEach(() => {
  if (prev === undefined) delete process.env["CAIRN_ROOT"];
  else process.env["CAIRN_ROOT"] = prev;
});

async function connect() {
  const dir = tempDir();
  init(dir, { name: "MCP Test" });
  process.env["CAIRN_ROOT"] = dir;
  const server = createServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client };
}
const textOf = (r: any) => r.content.map((c: any) => c.text).join("\n");

describe("Cairn MCP server", () => {
  it("exposes the protocol tools", async () => {
    const { client } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const t of [
      "append_event",
      "query_state",
      "query_memory",
      "query_timeline",
      "query_context",
      "register_agent",
      "create_snapshot",
      "get_active_tasks",
      "get_active_decisions",
    ]) {
      expect(names, t).toContain(t);
    }
  });

  it("drives a workflow through tool calls", async () => {
    const { client } = await connect();
    await client.callTool({ name: "register_agent", arguments: { name: "Claude Code" } });
    await client.callTool({
      name: "append_event",
      arguments: { type: "task.created", payload: { id: "t1", title: "Build OAuth", priority: "high" } },
    });
    await client.callTool({
      name: "append_event",
      arguments: { type: "decision.made", payload: { id: "d1", title: "Use SQLite", rationale: "WAL" } },
    });

    const tasks = JSON.parse(textOf(await client.callTool({ name: "get_active_tasks", arguments: {} })));
    expect(tasks[0].title).toBe("Build OAuth");

    const decisions = JSON.parse(textOf(await client.callTool({ name: "get_active_decisions", arguments: {} })));
    expect(decisions[0].title).toBe("Use SQLite");

    const ctx = JSON.parse(textOf(await client.callTool({ name: "query_context", arguments: { level: "small" } })));
    expect(ctx.currentTask.id).toBe("t1");

    await client.callTool({ name: "append_event", arguments: { type: "task.completed", payload: { id: "t1" } } });
    const after = JSON.parse(textOf(await client.callTool({ name: "get_active_tasks", arguments: {} })));
    expect(after).toHaveLength(0);
  });

  it("serves the state resource", async () => {
    const { client } = await connect();
    const read = await client.readResource({ uri: "cairn://state" });
    expect(read.contents[0]?.text).toContain("projectId");
  });
});
