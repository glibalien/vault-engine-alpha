import { describe, it, expect, vi } from "vitest";
import {
  expansionPairs, childQueryArgs, toggleExpand, reconcileExpansions,
} from "../../src/flows/expand.js";
import { createState } from "../../src/state.js";
import type { Client } from "../../src/client.js";
import type { Schema, NodeRow, Envelope, QueryNodesData } from "../../src/types.js";

const schema = (name: string, fields: Schema["fields"]): Schema => ({ name, display_name: null, fields });
const ref = (name: string, target?: string): Schema["fields"][number] =>
  ({ name, type: "reference", required: false, default_value: null, ...(target ? { reference_target: target } : {}), ui: null });
const listRef = (name: string, target: string): Schema["fields"][number] =>
  ({ name, type: "list", list_item_type: "reference", required: false, default_value: null, reference_target: target, ui: null });
const mk = (id: string): NodeRow => ({ id, file_path: `${id}.md`, title: id, types: ["task"], version: 3, field_count: 0 });
const okEnv = (nodes: NodeRow[], total: number, warnings: Envelope<QueryNodesData>["warnings"] = []): Envelope<QueryNodesData> =>
  ({ ok: true, data: { nodes, total }, warnings });

describe("expansionPairs", () => {
  const schemas = [
    schema("task", [ref("project", "project"), ref("parent_task", "task"), ref("owner", "person")]),
    schema("meeting", [listRef("projects", "project")]),
    schema("note", [ref("about")]), // no reference_target → never a pair
  ];

  it("finds (childType, viaField) pairs targeting the locked type, sorted", () => {
    expect(expansionPairs("project", schemas)).toEqual([
      { childType: "meeting", viaField: "projects" },   // list-of-reference counts
      { childType: "task", viaField: "project" },
    ]);
  });

  it("allows self-pairs (task.parent_task → task)", () => {
    expect(expansionPairs("task", schemas)).toEqual([{ childType: "task", viaField: "parent_task" }]);
  });

  it("returns [] when nothing targets the type", () => {
    expect(expansionPairs("person", [schemas[2]!])).toEqual([]);
  });
});

describe("childQueryArgs", () => {
  it("builds the identity join query", () => {
    expect(childQueryArgs({ childType: "task", viaField: "project" }, "p1")).toEqual({
      types: ["task"],
      join_filters: [{ rel_type: "project", target: { node_ids: ["p1"] } }],
      include_fields: ["*"],
      sort_by: "file_mtime", sort_order: "desc", limit: 25,
    });
  });
});

describe("toggleExpand", () => {
  const clientWith = (env: Envelope<QueryNodesData>): Client =>
    ({ queryNodes: vi.fn(async () => env) }) as unknown as Client;

  it("expands: stores rows/total and flags the unresolved warning", async () => {
    const s = createState({});
    const c = clientWith(okEnv([mk("c1")], 30, [{ code: "CROSS_NODE_FILTER_UNRESOLVED", message: "…", severity: "warning" }]));
    await toggleExpand(s, c, "p1", { childType: "task", viaField: "project" });
    const g = s.expanded.get("p1")!;
    expect(g.rows.map(r => r.id)).toEqual(["c1"]);
    expect(g.total).toBe(30);
    expect(g.unresolvedWarning).toBe(true);
    expect(g.busy).toBe(false);
  });

  it("collapses when called again with the same pair (discards rows)", async () => {
    const s = createState({});
    const c = clientWith(okEnv([mk("c1")], 1));
    await toggleExpand(s, c, "p1", { childType: "task", viaField: "project" });
    await toggleExpand(s, c, "p1", { childType: "task", viaField: "project" });
    expect(s.expanded.has("p1")).toBe(false);
  });

  it("re-queries when called with a different pair for the same parent", async () => {
    const s = createState({});
    const c = clientWith(okEnv([mk("c2")], 1));
    await toggleExpand(s, c, "p1", { childType: "task", viaField: "project" });
    await toggleExpand(s, c, "p1", { childType: "meeting", viaField: "projects" });
    expect(s.expanded.get("p1")!.childType).toBe("meeting");
  });

  it("drops the group when the expansion query fails", async () => {
    const s = createState({});
    const c = clientWith({ ok: false, error: { code: "X", message: "x" }, warnings: [] });
    await toggleExpand(s, c, "p1", { childType: "task", viaField: "project" });
    expect(s.expanded.has("p1")).toBe(false);
  });
});

describe("reconcileExpansions", () => {
  it("prunes groups whose parent vanished and re-queries survivors", async () => {
    const s = createState({});
    s.envelope = okEnv([mk("p1")], 1);
    s.expanded.set("p1", { childType: "task", viaField: "project", rows: [], total: 0, busy: false, unresolvedWarning: false });
    s.expanded.set("gone", { childType: "task", viaField: "project", rows: [], total: 0, busy: false, unresolvedWarning: false });
    const c = { queryNodes: vi.fn(async () => okEnv([mk("c9")], 1)) } as unknown as Client;
    await reconcileExpansions(s, c);
    expect(s.expanded.has("gone")).toBe(false);
    expect(s.expanded.get("p1")!.rows.map(r => r.id)).toEqual(["c9"]);
    expect((c.queryNodes as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });
});
