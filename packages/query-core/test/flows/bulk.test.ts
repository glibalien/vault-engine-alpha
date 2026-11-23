import { describe, it, expect } from "vitest";
import {
  buildBulkOps, decideBulkDry, applyBulkResults, buildInverseOps, pruneBulkSelection,
} from "../../src/flows/bulk.js";
import { createState } from "../../src/state.js";
import type { BatchResult, BulkPlan, Envelope, BatchDryRunData, NodeRow } from "../../src/types.js";

const mk = (id: string, version = 1, fields: Record<string, unknown> = {}, types = ["task"]): NodeRow =>
  ({ id, file_path: `${id}.md`, title: id, types, version, field_count: 0, fields });

const setStatus: BulkPlan = { kind: "setField", field: "status", value: "done" };

describe("buildBulkOps", () => {
  it("one update op per row with the live expected_version", () => {
    expect(buildBulkOps(setStatus, [{ id: "a", version: 3 }, { id: "b", version: 7 }])).toEqual([
      { op: "update", params: { node_id: "a", set_fields: { status: "done" }, expected_version: 3 } },
      { op: "update", params: { node_id: "b", set_fields: { status: "done" }, expected_version: 7 } },
    ]);
  });

  it("maps type plans to add_types / remove_types", () => {
    expect(buildBulkOps({ kind: "addType", type: "urgent" }, [{ id: "a", version: 1 }])[0]!.params.add_types).toEqual(["urgent"]);
    expect(buildBulkOps({ kind: "removeType", type: "task" }, [{ id: "a", version: 1 }])[0]!.params.remove_types).toEqual(["task"]);
  });
});

describe("decideBulkDry", () => {
  const ok = (data: BatchDryRunData, warnings: Envelope<BatchDryRunData>["warnings"] = []): Envelope<BatchDryRunData> =>
    ({ ok: true, data, warnings });

  it("clean dry run → confirm with count + warnings", () => {
    const env = ok({ dry_run: true, op_count: 2, would_apply: [{ op: "update" }, { op: "update" }] },
      [{ code: "LAST_TYPE_REMOVAL", message: "…", severity: "warning" }]);
    expect(decideBulkDry(env)).toEqual({ kind: "confirm", wouldApply: 2, warnings: env.warnings });
  });

  it("mid-batch dry-run failure → failed with the op's node", () => {
    const env = ok({ dry_run: true, would_apply: [], failed_at: 1, op: "update", message: "Not a valid value." });
    const d = decideBulkDry(env, [{ op: "update", params: { node_id: "a" } }, { op: "update", params: { node_id: "b" } }]);
    expect(d).toEqual({ kind: "failed", nodeId: "b", message: "Not a valid value." });
  });

  it("ok:false envelope → failed (BATCH_FAILED details drive the node)", () => {
    const env: Envelope<BatchDryRunData> = {
      ok: false,
      error: { code: "BATCH_FAILED", message: "boom", details: { failed_at: 0 } },
      warnings: [],
    };
    const d = decideBulkDry(env, [{ op: "update", params: { node_id: "a" } }]);
    expect(d).toEqual({ kind: "failed", nodeId: "a", message: "boom" });
  });
});

describe("applyBulkResults", () => {
  it("applied → version overlay + field overlay + flash; stale → staleSet", () => {
    const s = createState({});
    s.envelope = { ok: true, data: { nodes: [mk("a", 3), mk("b", 7)], total: 2 }, warnings: [] };
    const results: BatchResult[] = [
      { op: "update", op_index: 0, status: "applied", node_id: "a", new_version: 4 },
      { op: "update", op_index: 1, status: "stale", node_id: "b",
        details: { current_version: 9, expected_version: 7 } },
    ];
    const out = applyBulkResults(s, setStatus, results);
    expect(out).toEqual({ applied: 1, stale: ["b"] });
    expect(s.versions["a"]).toBe(4);
    expect(s.values["a"]).toEqual({ status: "done" });
    expect(s.flash.has("a:status")).toBe(true);
    expect(s.staleSet.has("b")).toBe(true);
  });

  it("type plans overlay nothing on values but still bump versions", () => {
    const s = createState({});
    const results: BatchResult[] = [{ op: "update", op_index: 0, status: "applied", node_id: "a", new_version: 2 }];
    applyBulkResults(s, { kind: "addType", type: "urgent" }, results);
    expect(s.versions["a"]).toBe(2);
    expect(s.values["a"]).toBeUndefined();
  });
});

describe("buildInverseOps", () => {
  it("setField inverse restores each row's prior value at the new version", () => {
    const rows = [
      { id: "a", prior: { value: "open" }, newVersion: 4 },
      { id: "b", prior: { value: null }, newVersion: 9 },
    ];
    expect(buildInverseOps(setStatus, rows)).toEqual([
      { op: "update", params: { node_id: "a", set_fields: { status: "open" }, expected_version: 4 } },
      { op: "update", params: { node_id: "b", set_fields: { status: null }, expected_version: 9 } },
    ]);
  });

  it("addType inverse removes; removeType inverse re-adds", () => {
    expect(buildInverseOps({ kind: "addType", type: "urgent" }, [{ id: "a", prior: {}, newVersion: 2 }])[0]!.params.remove_types)
      .toEqual(["urgent"]);
    expect(buildInverseOps({ kind: "removeType", type: "task" }, [{ id: "a", prior: {}, newVersion: 2 }])[0]!.params.add_types)
      .toEqual(["task"]);
  });
});

describe("pruneBulkSelection", () => {
  it("keeps only ids still present in the envelope", () => {
    const s = createState({});
    s.bulkSelected = new Set(["a", "gone"]);
    s.envelope = { ok: true, data: { nodes: [mk("a")], total: 1 }, warnings: [] };
    pruneBulkSelection(s);
    expect([...s.bulkSelected]).toEqual(["a"]);
  });
});
