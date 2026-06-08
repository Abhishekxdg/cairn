import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { tempProject, cleanup } from "./helpers.js";
import { createServer } from "../src/mcp/server.js";
import { init } from "../src/core/index.js";

let dirs: string[] = [];
let prevRoot: string | undefined;

beforeEach(() => {
  prevRoot = process.env["STATED_ROOT"];
});
afterEach(() => {
  if (prevRoot === undefined) delete process.env["STATED_ROOT"];
  else process.env["STATED_ROOT"] = prevRoot;
  for (const d of dirs) cleanup(d);
  dirs = [];
});

async function connect(): Promise<{ client: Client; root: string }> {
  const root = tempProject();
  dirs.push(root);
  init(root);
  process.env["STATED_ROOT"] = root;

  const server = createServer();
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, root };
}

function textOf(result: any): string {
  return result.content.map((c: any) => c.text).join("\n");
}

describe("MCP server", () => {
  it("exposes the expected tools", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const expected of [
      "register_agent",
      "get_state",
      "get_handoff",
      "create_task",
      "claim_task",
      "complete_task",
      "create_decision",
      "claim_file",
      "release_file",
      "generate_handoff",
    ]) {
      expect(names, expected).toContain(expected);
    }
  });

  it("drives a full workflow through tool calls", async () => {
    const { client } = await connect();

    await client.callTool({
      name: "register_agent",
      arguments: { name: "Claude Code" },
    });

    const created = await client.callTool({
      name: "create_task",
      arguments: { title: "Build OAuth", priority: "high" },
    });
    const task = JSON.parse(textOf(created));
    expect(task.id).toMatch(/^t_/);

    await client.callTool({
      name: "claim_task",
      arguments: { id: task.id, owner: "Claude Code" },
    });

    await client.callTool({
      name: "create_decision",
      arguments: { decision: "Use BullMQ", reason: "Reliable retries" },
    });

    const stateRes = await client.callTool({ name: "get_state", arguments: {} });
    const state = JSON.parse(textOf(stateRes));
    expect(state.activeTasks[0].title).toBe("Build OAuth");
    expect(state.recentDecisions[0].decision).toBe("Use BullMQ");
    expect(state.activeAgents.some((a: any) => a.name === "Claude Code")).toBe(true);

    const handoff = await client.callTool({
      name: "get_handoff",
      arguments: {},
    });
    expect(textOf(handoff)).toContain("Build OAuth");

    await client.callTool({
      name: "complete_task",
      arguments: { id: task.id },
    });
    const after = JSON.parse(
      textOf(await client.callTool({ name: "get_state", arguments: {} })),
    );
    expect(after.activeTasks).toHaveLength(0);
  });

  it("serves read-only resources", async () => {
    const { client } = await connect();
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toEqual(
      expect.arrayContaining(["stated://handoff", "stated://state"]),
    );
    const read = await client.readResource({ uri: "stated://state" });
    expect(read.contents[0]?.text).toContain("\"version\"");
  });
});
