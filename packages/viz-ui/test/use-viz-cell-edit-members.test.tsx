// @vitest-environment jsdom
/**
 * #285 INV-8: a list-of-references member edit commits one add or remove through
 * update-node `reference_edit`, never set_fields, so the other links stay as stored.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import React from "react";
import type { Client, ReferenceEditCommitData } from "@vault/query-core";
import { applyMemberCommit, useVizCellEdit, type ReferenceMemberChange, type VizCellEditOverlay } from "../src/use-viz-cell-edit.js";
import type { VizRow } from "../src/viz-spec.js";

const row: VizRow = {
  id: "p1", title: "Project", file_path: "Projects/Project.md", types: ["project"],
  fields: { company: ["Company A", "Company B"] }, version: 7,
};

function commitData(after: string[], { changed = true, version = 8 } = {}): ReferenceEditCommitData {
  return {
    node_id: "p1", file_path: "Projects/Project.md", title: "Project", types: ["project"],
    coerced_state: { company: { field: "company", value: after, source: "provided", changed } },
    orphan_fields: [], version, content_hash: "hash-after",
    reference_edit: { field: "company", action: "add", target: { node_id: "c3" }, outcome: changed ? "added" : "already_present", changed },
  };
}

const ok = <T,>(data: T) => ({ ok: true as const, data, warnings: [] });
const fail = (code: string, message: string, details?: Record<string, unknown>) =>
  ({ ok: false as const, error: { code, message, details }, warnings: [] });

function makeClient(overrides: Partial<Client>): Client {
  return {
    updateNode: vi.fn(), getNode: vi.fn(), editReferenceMember: vi.fn(),
    ...overrides,
  } as unknown as Client;
}

function Probe({ client, change, onAfterCommit }: { client: Client; change: ReferenceMemberChange; onAfterCommit?: () => void }) {
  const api = useVizCellEdit(client, onAfterCommit);
  return (
    <div>
      <span data-testid="value">{JSON.stringify(api.cellValue(row, "company"))}</span>
      <span data-testid="editing">{api.editing ? `${api.editing.id}:${api.editing.field}` : "none"}</span>
      <span data-testid="error">{api.cellError ? `${api.cellError.code}:${api.cellError.message}` : "none"}</span>
      <span data-testid="stale">{api.isStale("p1") ? "stale" : "fresh"}</span>
      <button data-testid="begin" onClick={() => api.beginEdit("p1", "company")}>begin</button>
      <button data-testid="go" onClick={() => void api.editReferenceMember!(row, "company", change)}>go</button>
    </div>
  );
}

async function run(client: Client, change: ReferenceMemberChange, onAfterCommit?: () => void) {
  render(<Probe client={client} change={change} onAfterCommit={onAfterCommit} />);
  act(() => { screen.getByTestId("begin").click(); });
  await act(async () => { screen.getByTestId("go").click(); });
}

afterEach(() => cleanup());

describe("applyMemberCommit (pure)", () => {
  it("overlays the list and version but keeps the editor open", () => {
    const state: VizCellEditOverlay = {
      values: {}, titles: {}, versions: {}, staleSet: new Set(), staleNodes: {}, flash: new Set(),
      editing: { id: "p1", field: "company" }, pending: null, cellError: { id: "p1", field: "company", code: "X", message: "x" }, busy: false,
    };
    const next = applyMemberCommit(state, "p1", "company", ["A"], 9);
    expect(next.values.p1?.company).toEqual(["A"]);
    expect(next.versions.p1).toBe(9);
    expect(next.editing).toEqual({ id: "p1", field: "company" });
    expect(next.cellError).toBeNull();
  });
});

describe("editReferenceMember (INV-8)", () => {
  it("adds a third link by node id, keeping all three, without set_fields or a content hash", async () => {
    const editReferenceMember = vi.fn().mockResolvedValue(ok(commitData(["Company A", "Company B", "Company C"])));
    const client = makeClient({ editReferenceMember });
    const onAfterCommit = vi.fn();
    await run(client, { action: "add", nodeId: "c3" }, onAfterCommit);

    expect(editReferenceMember).toHaveBeenCalledWith({
      node_id: "p1",
      reference_edit: { field: "company", action: "add", target: { node_id: "c3" } },
      expected_version: 7,
    });
    expect(client.updateNode).not.toHaveBeenCalled();
    expect(client.getNode).not.toHaveBeenCalled();
    expect(screen.getByTestId("value").textContent).toBe(JSON.stringify(["Company A", "Company B", "Company C"]));
    expect(screen.getByTestId("editing").textContent).toBe("p1:company");
    expect(onAfterCommit).toHaveBeenCalledTimes(1);
  });

  it("removes one link by its stored text with both guards, keeping the other", async () => {
    const getNode = vi.fn().mockResolvedValue(ok({ id: "p1", file_path: "Projects/Project.md", title: "Project", types: ["project"], fields: {}, body: "", version: 7, metadata: { content_hash: "hash-before" } }));
    const editReferenceMember = vi.fn().mockResolvedValue(ok(commitData(["Company A"])));
    const client = makeClient({ getNode, editReferenceMember });
    await run(client, { action: "remove", storedValue: "Company B" });

    expect(editReferenceMember).toHaveBeenCalledWith({
      node_id: "p1",
      reference_edit: { field: "company", action: "remove", target: { stored_value: "Company B" } },
      expected_version: 7,
      expected_content_hash: "hash-before",
    });
    expect(screen.getByTestId("value").textContent).toBe(JSON.stringify(["Company A"]));
  });

  it("removing the last link leaves an empty list", async () => {
    const getNode = vi.fn().mockResolvedValue(ok({ id: "p1", version: 7, metadata: { content_hash: "h" }, fields: {}, types: [], title: "Project", file_path: "x", body: "" }));
    const client = makeClient({ getNode, editReferenceMember: vi.fn().mockResolvedValue(ok(commitData([]))) });
    await run(client, { action: "remove", storedValue: "Company A" });
    expect(screen.getByTestId("value").textContent).toBe("[]");
  });

  it("refuses a removal when get-node gives no content hash, and writes nothing", async () => {
    // A top-level content_hash is not where get-node puts it.
    const getNode = vi.fn().mockResolvedValue(ok({ id: "p1", version: 7, content_hash: "top-level", metadata: { content_hash: null }, fields: {}, types: [], title: "Project", file_path: "x", body: "" }));
    const client = makeClient({ getNode });
    await run(client, { action: "remove", storedValue: "Company B" });
    expect(client.editReferenceMember).not.toHaveBeenCalled();
    expect(screen.getByTestId("error").textContent).toMatch(/^VERSION_UNKNOWN:/);
    expect(screen.getByTestId("value").textContent).toBe(JSON.stringify(["Company A", "Company B"]));
  });

  it("marks the row stale on STALE_NODE", async () => {
    const client = makeClient({ editReferenceMember: vi.fn().mockResolvedValue(fail("STALE_NODE", "changed", { current_version: 9, expected_version: 7 })) });
    await run(client, { action: "add", nodeId: "c3" });
    expect(screen.getByTestId("stale").textContent).toBe("stale");
    expect(screen.getByTestId("editing").textContent).toBe("none");
  });

  it("shows an engine refusal inline and keeps the editor open", async () => {
    const client = makeClient({ editReferenceMember: vi.fn().mockResolvedValue(fail("NOT_ELIGIBLE", "Reference target has the wrong type")) });
    await run(client, { action: "add", nodeId: "c3" });
    expect(screen.getByTestId("error").textContent).toBe("NOT_ELIGIBLE:Reference target has the wrong type");
    expect(screen.getByTestId("editing").textContent).toBe("p1:company");
    expect(screen.getByTestId("value").textContent).toBe(JSON.stringify(["Company A", "Company B"]));
  });

  it("an already-present link changes nothing and calls no after-commit hook", async () => {
    const onAfterCommit = vi.fn();
    const client = makeClient({ editReferenceMember: vi.fn().mockResolvedValue(ok(commitData(["Company A", "Company B"], { changed: false, version: 7 }))) });
    await run(client, { action: "add", nodeId: "c1" }, onAfterCommit);
    expect(onAfterCommit).not.toHaveBeenCalled();
    expect(screen.getByTestId("editing").textContent).toBe("p1:company");
  });
});
