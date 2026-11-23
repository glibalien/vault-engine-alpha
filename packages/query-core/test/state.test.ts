import { describe, it, expect } from "vitest";
import { createState, findRow, resolveTypeLock } from "../src/state.js";
import type { ExpandedGroup, NodeRow } from "../src/types.js";

function row(types: string[]): NodeRow {
  return {
    id: `id-${types.join("-")}`,
    file_path: "x.md",
    title: "x",
    types,
    version: 1,
    field_count: 0,
  };
}

describe("createState", () => {
  it("parses incoming args into owned state", () => {
    const args = {
      types: ["task"],
      path_dir: "Projects",
      fields: { status: { one_of: ["open"] } },
      limit: 10,
    };
    const s = createState(args);
    expect(s.initialArgs).toEqual(args);
    expect(s.initialArgs).not.toBe(args);  // deep clone
    expect(s.typeSelection).toBe("task");
    expect(s.strip).toEqual({ title_contains: "", query: "", sort_by: "title", sort_order: "asc", limit: 10 });
    expect(s.callerFragments.map(f => f.key).sort()).toEqual(["fields", "path_dir"]);
    expect(s.lockedType).toBeNull();
    expect(s.schemaCache.size).toBe(0);
    expect(s.envelope).toBeNull();
    expect(s.visibleColumns).toBeNull();
    expect(s.availableTypes).toEqual([]);
    expect(s.expanded.size).toBe(0);
  });
});

describe("findRow", () => {
  const mk = (id: string): NodeRow => ({
    id, file_path: `${id}.md`, title: id, types: ["task"], version: 1, field_count: 0,
  });
  const stateWith = () => {
    const s = createState({});
    s.envelope = { ok: true, data: { nodes: [mk("m1"), mk("m2")], total: 2 }, warnings: [] };
    s.expanded.set("m1", {
      childType: "task", viaField: "project", rows: [mk("c1")], total: 1,
      busy: false, unresolvedWarning: false,
    } as ExpandedGroup);
    return s;
  };

  it("finds a main-table row", () => {
    expect(findRow(stateWith(), "m2")?.id).toBe("m2");
  });

  it("finds a row inside an expanded group", () => {
    expect(findRow(stateWith(), "c1")?.id).toBe("c1");
  });

  it("returns undefined for unknown ids and on error envelopes", () => {
    const s = stateWith();
    expect(findRow(s, "nope")).toBeUndefined();
    s.envelope = { ok: false, error: { code: "X", message: "x" }, warnings: [] };
    expect(findRow(s, "m1")).toBeUndefined();   // main gone…
    expect(findRow(s, "c1")?.id).toBe("c1");    // …expanded rows still reachable
  });
});

describe("resolveTypeLock", () => {
  it("locks to the types arg when exactly one is given", () => {
    expect(resolveTypeLock(["task"])).toEqual({ kind: "locked", type: "task" });
  });

  it("locks to result-row consensus when no types are given and all rows share a type", () => {
    const rows = [row(["task"]), row(["task"]), row(["task"])];
    expect(resolveTypeLock(undefined, rows)).toEqual({ kind: "locked", type: "task" });
  });

  it("locks to result-row consensus when no types are given and rows share types[0]", () => {
    const rows = [row(["task", "archived"]), row(["task"])];
    expect(resolveTypeLock(undefined, rows)).toEqual({ kind: "locked", type: "task" });
  });

  it("returns unlocked + candidate list when rows span multiple types", () => {
    const rows = [row(["task"]), row(["project"]), row(["task"])];
    expect(resolveTypeLock(undefined, rows)).toEqual({
      kind: "unlocked",
      candidates: ["project", "task"],
    });
  });

  it("returns unlocked when multiple types are given", () => {
    const rows = [row(["task"]), row(["project"])];
    expect(resolveTypeLock(["task", "project"], rows)).toEqual({
      kind: "unlocked",
      candidates: ["project", "task"],
    });
  });

  it("returns unlocked with no candidates when no rows are available", () => {
    expect(resolveTypeLock(undefined)).toEqual({ kind: "unlocked", candidates: [] });
  });

  it("returns unlocked with no candidates for an empty result set", () => {
    expect(resolveTypeLock(undefined, [])).toEqual({ kind: "unlocked", candidates: [] });
  });
});
