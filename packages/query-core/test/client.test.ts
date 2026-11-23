import { describe, it, expect, vi } from "vitest";
import { makeClient } from "../src/client.js";
import type { BatchOp } from "../src/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

function tr(body: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(body) }] };
}

describe("makeClient", () => {
  it("dispatches each tool by name with the given args", async () => {
    const callServerTool = vi.fn(async ({ name }: { name: string }) => {
      if (name === "query-nodes") return tr({ ok: true, data: { nodes: [], total: 0 }, warnings: [] });
      if (name === "describe-schema") return tr({ ok: true, data: { name: "task", display_name: null, fields: [] }, warnings: [] });
      throw new Error(`unexpected ${name}`);
    });

    const client = makeClient(callServerTool);

    const q = await client.queryNodes({ types: ["task"] });
    expect(q.ok).toBe(true);
    expect(callServerTool).toHaveBeenCalledWith({ name: "query-nodes", arguments: { types: ["task"] } });

    const s = await client.describeSchema("task");
    expect(s.ok).toBe(true);
    expect(callServerTool).toHaveBeenLastCalledWith({ name: "describe-schema", arguments: { name: "task" } });
  });

  it("dispatches updateNode / renameNode / getNode by name", async () => {
    const calls: { name: string; arguments: unknown }[] = [];
    const callServerTool = vi.fn(async (req: { name: string; arguments?: unknown }) => {
      calls.push({ name: req.name, arguments: req.arguments });
      return tr({ ok: true, data: {}, warnings: [] });
    });
    const client = makeClient(callServerTool);

    await client.updateNode({ node_id: "t-1", set_fields: { status: "done" }, expected_version: 3, dry_run: true });
    expect(calls[0]).toEqual({ name: "update-node", arguments: { node_id: "t-1", set_fields: { status: "done" }, expected_version: 3, dry_run: true } });

    await client.renameNode({ node_id: "t-1", new_title: "X", expected_version: 3 });
    expect(calls[1]).toEqual({ name: "update-node", arguments: { node_id: "t-1", set_title: "X", expected_version: 3 } });

    await client.getNode({ node_id: "t-1" });
    expect(calls[2]).toEqual({ name: "get-node", arguments: { node_id: "t-1" } });
  });

  it("dispatches createNode / deleteNode by name", async () => {
    const calls: { name: string; arguments: unknown }[] = [];
    const callServerTool = vi.fn(async (req: { name: string; arguments?: unknown }) => {
      calls.push({ name: req.name, arguments: req.arguments });
      return tr({ ok: true, data: {}, warnings: [] });
    });
    const client = makeClient(callServerTool);

    await client.createNode({ title: "X", types: ["task"], fields: { status: "open" }, dry_run: true });
    expect(calls[0]).toEqual({
      name: "create-node",
      arguments: { title: "X", types: ["task"], fields: { status: "open" }, dry_run: true },
    });

    await client.deleteNode({ node_id: "t-1", confirm: true });
    expect(calls[1]).toEqual({ name: "delete-node", arguments: { node_id: "t-1", confirm: true } });
  });

  it("dispatches batchMutate by name with explicit dry_run", async () => {
    const calls: { name: string; arguments: unknown }[] = [];
    const callServerTool = vi.fn(async (req: { name: string; arguments?: unknown }) => {
      calls.push({ name: req.name, arguments: req.arguments });
      return tr({ ok: true, data: {}, warnings: [] });
    });
    const client = makeClient(callServerTool);
    const ops: BatchOp[] = [{ op: "update", params: { node_id: "t-1", set_fields: { status: "done" }, expected_version: 3 } }];
    await client.batchMutate({ operations: ops, dry_run: true });
    expect(calls[0]).toEqual({ name: "batch-mutate", arguments: { operations: ops, dry_run: true } });
  });
});

it("preserves null typed-reference IDs and unknown warning codes without extra lookup", async () => {
  const data = { id: "task", relationships: { outgoing: { project: [{ target_id: null, target_title: "Same" }] }, incoming: {} } };
  const warnings = [{ code: "FUTURE_REFERENCE_WARNING", severity: "warning", message: "unresolved" }];
  const call = vi.fn(async () => tr({ ok: true, data, warnings }));
  expect(await makeClient(call).getNode({ node_id: "task" })).toEqual({ ok: true, data, warnings });
  expect(call).toHaveBeenCalledTimes(1);
});
