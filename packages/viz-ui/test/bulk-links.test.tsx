// @vitest-environment jsdom
/**
 * #285 BULK-INV-7: Add link / Remove link on the selected rows edit one member of a
 * list-of-references field per row (update-node reference_edit), so no row loses its other
 * links. Every row is previewed before anything is written; the commit goes row by row.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import type { Client, Schema } from "@vault/query-core";
import { reduceBulk, useVizBulk, type BulkReducerState, type VizBulkAPI } from "../src/use-viz-bulk.js";
import { BulkBar } from "../src/BulkBar.js";
import type { VizRow } from "../src/viz-spec.js";
import { withClient } from "./_render-viz.js";

afterEach(() => cleanup());

const ACME = { id: "c-acme", title: "Acme" };
const ADD_PLAN = { kind: "addLink" as const, field: "company", target: ACME };

const row = (id: string, version: number): VizRow & { version: number } =>
  ({ id, title: `Project ${id}`, file_path: `${id}.md`, types: ["project"], fields: {}, version });

const ok = <T,>(data: T) => ({ ok: true as const, data, warnings: [] as Array<{ code: string; message: string; severity: "error" | "warning" }> });
const fail = (code: string, message: string) => ({ ok: false as const, error: { code, message }, warnings: [] });
const preview = (wouldChange: boolean) => ok({ dry_run: true as const, reference_edit: { field: "company", action: "add" as const, target: { node_id: ACME.id }, outcome: wouldChange ? "added" as const : "already_present" as const, would_change: wouldChange } });
const commit = (changed: boolean) => ok({ reference_edit: { changed } });

function empty(): BulkReducerState {
  return { selected: new Set(), plan: null, picking: null, pending: null, failed: null, busy: false, outcome: null };
}

describe("reducer", () => {
  it("picks the op, then a list field, then the note", () => {
    let s = reduceBulk(empty(), { type: "PICK", mode: "addLink" });
    expect(s).toMatchObject({ plan: { kind: "addLink", field: "", target: null }, picking: "linkField" });
    expect(reduceBulk(s, { type: "SET_LINK_TARGET", target: ACME })).toBe(s); // no field yet
    s = reduceBulk(s, { type: "SET_LINK_FIELD", field: "company" });
    expect(s).toMatchObject({ plan: { field: "company", target: null }, picking: "linkTarget" });
    s = reduceBulk(s, { type: "SET_LINK_TARGET", target: ACME });
    expect(s).toMatchObject({ plan: ADD_PLAN, picking: null });
    expect(reduceBulk(reduceBulk(empty(), { type: "PICK", mode: "removeLink" }), { type: "SET_LINK_FIELD", field: "company" }).plan)
      .toEqual({ kind: "removeLink", field: "company", target: null });
  });
});

/** Drive the real hook through a link plan on the given rows. */
function Probe({ client, rows, onAfterCommit, apiRef }: {
  client: Client; rows: Array<VizRow & { version?: number }>; onAfterCommit?: () => void; apiRef: { current: VizBulkAPI | null };
}) {
  const api = useVizBulk(client, rows, onAfterCommit);
  apiRef.current = api;
  return null;
}

async function planned(client: Client, rows: Array<VizRow & { version?: number }>, onAfterCommit?: () => void) {
  const apiRef: { current: VizBulkAPI | null } = { current: null };
  render(<Probe client={client} rows={rows} onAfterCommit={onAfterCommit} apiRef={apiRef} />);
  act(() => { apiRef.current!.toggleAll(rows); });
  act(() => { apiRef.current!.pick("addLink"); });
  act(() => { apiRef.current!.setLinkField("company"); });
  act(() => { apiRef.current!.setLinkTarget(ACME); });
  return apiRef;
}

describe("useVizBulk link plans", () => {
  it("previews every versioned row before writing, with its version, and never uses batch-mutate", async () => {
    const previewReferenceMember = vi.fn().mockResolvedValueOnce(preview(true)).mockResolvedValueOnce(preview(false));
    const client = { previewReferenceMember, editReferenceMember: vi.fn(), batchMutate: vi.fn() } as unknown as Client;
    const rows = [row("p1", 3), row("p2", 8), { ...row("p3", 1), version: undefined }];
    const api = await planned(client, rows);
    await act(async () => { await api.current!.runDry(); });

    expect(previewReferenceMember.mock.calls.map((c) => c[0])).toEqual([
      { node_id: "p1", reference_edit: { field: "company", action: "add", target: { node_id: ACME.id } }, expected_version: 3 },
      { node_id: "p2", reference_edit: { field: "company", action: "add", target: { node_id: ACME.id } }, expected_version: 8 },
    ]);
    expect(api.current!.pending).toEqual({ wouldApply: 1, unchanged: 1, warnings: [], skippedNoVersion: 1 });
    expect(client.editReferenceMember).not.toHaveBeenCalled();
    expect(client.batchMutate).not.toHaveBeenCalled();
  });

  it("fails without writing when any row's preview is refused", async () => {
    const client = {
      previewReferenceMember: vi.fn().mockResolvedValueOnce(preview(true)).mockResolvedValueOnce(fail("NOT_ELIGIBLE", "Field must be a claimed reference list")),
      editReferenceMember: vi.fn(),
    } as unknown as Client;
    const api = await planned(client, [row("p1", 1), row("p2", 1)]);
    await act(async () => { await api.current!.runDry(); });
    expect(api.current!.failed).toEqual({ nodeId: "p2", message: "Project p2: Field must be a claimed reference list" });
    expect(api.current!.pending).toBeNull();
    expect(client.editReferenceMember).not.toHaveBeenCalled();
  });

  it("commits row by row and counts applied, unchanged, stale and failed rows", async () => {
    const editReferenceMember = vi.fn()
      .mockResolvedValueOnce(commit(true))
      .mockResolvedValueOnce(commit(false))
      .mockResolvedValueOnce(fail("STALE_NODE", "changed"))
      .mockResolvedValueOnce(fail("AMBIGUOUS_MATCH", "ambiguous"));
    const client = { previewReferenceMember: vi.fn().mockResolvedValue(preview(true)), editReferenceMember } as unknown as Client;
    const onAfterCommit = vi.fn();
    const rows = [row("p1", 1), row("p2", 2), row("p3", 3), row("p4", 4)];
    const api = await planned(client, rows, onAfterCommit);
    await act(async () => { await api.current!.runDry(); });
    await act(async () => { await api.current!.confirm(); });

    expect(editReferenceMember.mock.calls.map((c) => c[0].node_id)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(editReferenceMember.mock.calls[3]![0]).toEqual({
      node_id: "p4", reference_edit: { field: "company", action: "add", target: { node_id: ACME.id } }, expected_version: 4,
    });
    expect(api.current!.outcome).toEqual({ applied: 1, unchanged: 1, stale: 1, failed: 1 });
    expect(onAfterCommit).toHaveBeenCalledTimes(1);
    expect(api.current!.selectedCount).toBe(0);
  });

  it("publishes the partial outcome and refreshes when a commit request fails mid-way", async () => {
    const editReferenceMember = vi.fn()
      .mockResolvedValueOnce(commit(true))
      .mockRejectedValueOnce(new Error("Engine unreachable"))
      .mockResolvedValue(commit(true));
    const client = { previewReferenceMember: vi.fn().mockResolvedValue(preview(true)), editReferenceMember } as unknown as Client;
    const onAfterCommit = vi.fn();
    const api = await planned(client, [row("p1", 1), row("p2", 1), row("p3", 1), row("p4", 1)], onAfterCommit);
    await act(async () => { await api.current!.runDry(); });
    await act(async () => { await api.current!.confirm(); });
    expect(editReferenceMember).toHaveBeenCalledTimes(2);
    expect(api.current!.outcome).toEqual({ applied: 1, stale: 0, unchanged: 0, failed: 0, uncertain: 1, notAttempted: 2, error: "Engine unreachable" });
    expect(api.current!.pending).toBeNull();
    expect(api.current!.busy).toBe(false);
    expect(onAfterCommit).toHaveBeenCalledTimes(1);
  });

  it("fails the plan, writing nothing, when a preview request fails", async () => {
    const client = {
      previewReferenceMember: vi.fn().mockResolvedValueOnce(preview(true)).mockRejectedValueOnce(new Error("Engine unreachable")),
      editReferenceMember: vi.fn(),
    } as unknown as Client;
    const api = await planned(client, [row("p1", 1), row("p2", 1)]);
    await act(async () => { await api.current!.runDry(); });
    expect(api.current!.failed).toEqual({ nodeId: "p2", message: "Project p2: Engine unreachable" });
    expect(api.current!.busy).toBe(false);
    expect(client.editReferenceMember).not.toHaveBeenCalled();
  });

  it("removes by node id and skips the refresh when nothing changed", async () => {
    const editReferenceMember = vi.fn().mockResolvedValue(commit(false));
    const client = { previewReferenceMember: vi.fn().mockResolvedValue(preview(false)), editReferenceMember } as unknown as Client;
    const onAfterCommit = vi.fn();
    const apiRef: { current: VizBulkAPI | null } = { current: null };
    const rows = [row("p1", 2)];
    render(<Probe client={client} rows={rows} onAfterCommit={onAfterCommit} apiRef={apiRef} />);
    act(() => { apiRef.current!.toggleAll(rows); });
    act(() => { apiRef.current!.pick("removeLink"); });
    act(() => { apiRef.current!.setLinkField("company"); });
    act(() => { apiRef.current!.setLinkTarget(ACME); });
    await act(async () => { await apiRef.current!.runDry(); });
    await act(async () => { await apiRef.current!.confirm(); });
    expect(editReferenceMember).toHaveBeenCalledWith({
      node_id: "p1", reference_edit: { field: "company", action: "remove", target: { node_id: ACME.id } }, expected_version: 2,
    });
    expect(apiRef.current!.outcome).toEqual({ applied: 0, unchanged: 1, stale: 0, failed: 0 });
    expect(onAfterCommit).not.toHaveBeenCalled();
  });
});

// ── BulkBar ──────────────────────────────────────────────────────────────────

const SCHEMA: Schema = {
  name: "project", display_name: "Project",
  fields: [
    { name: "owner", type: "reference", required: false, default_value: null },
    { name: "company", type: "list", list_item_type: "reference", reference_target: "company", required: false, default_value: null },
    { name: "tags", type: "list", list_item_type: "string", required: false, default_value: null },
  ],
};
const PLAIN: Schema = { name: "note", display_name: "Note", fields: [{ name: "summary", type: "string", required: false, default_value: null }] };

function api(overrides: Partial<VizBulkAPI> = {}): VizBulkAPI {
  return {
    selected: new Set(["p1", "p2"]), selectedCount: 2,
    isSelected: vi.fn(), allSelected: vi.fn(), toggleRow: vi.fn(), toggleAll: vi.fn(), clear: vi.fn(),
    plan: null, picking: null, pending: null, failed: null, busy: false, outcome: null,
    pick: vi.fn(), setPlanField: vi.fn(), setPlanValue: vi.fn(), setPlanType: vi.fn(),
    setLinkField: vi.fn(), setLinkTarget: vi.fn(),
    runDry: vi.fn(), confirm: vi.fn(), cancel: vi.fn(),
    ...overrides,
  };
}

describe("BulkBar link ops", () => {
  it("offers Add link and Remove link only when the schema has a list-of-references field", () => {
    const bulk = api();
    render(<BulkBar bulk={bulk} schema={SCHEMA} />);
    fireEvent.click(screen.getByText("Add link…"));
    expect(bulk.pick).toHaveBeenCalledWith("addLink");
    fireEvent.click(screen.getByText("Remove link…"));
    expect(bulk.pick).toHaveBeenCalledWith("removeLink");
    cleanup();
    render(<BulkBar bulk={api()} schema={PLAIN} />);
    expect(screen.queryByText("Add link…")).toBeNull();
  });

  it("lists only list-of-references fields to link", () => {
    const bulk = api({ picking: "linkField", plan: { kind: "addLink", field: "", target: null } });
    render(<BulkBar bulk={bulk} schema={SCHEMA} />);
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["companylinks"]);
    fireEvent.mouseDown(screen.getByRole("menuitem"));
    expect(bulk.setLinkField).toHaveBeenCalledWith("company");
  });

  it("picks an existing note for the link, with no keep-unresolved option", async () => {
    const client = {
      queryNodes: vi.fn().mockResolvedValue({ ok: true, warnings: [], data: { nodes: [{ id: ACME.id, title: ACME.title, types: ["company"], file_path: "Acme.md", version: 1, field_count: 0 }], total: 1 } }),
    } as unknown as Client;
    const bulk = api({ picking: "linkTarget", plan: { kind: "addLink", field: "company", target: null } });
    const { container } = render(<BulkBar bulk={bulk} schema={SCHEMA} />, { wrapper: withClient(client) });
    const input = container.querySelector(".ref-autocomplete-input")!;
    fireEvent.change(input, { target: { value: "Ac" } });
    await act(async () => { await new Promise((r) => setTimeout(r, 260)); });
    expect(container.querySelector(".ref-autocomplete-keep")).toBeNull();
    fireEvent.mouseDown(container.querySelector(".ref-autocomplete-opt")!);
    expect(bulk.setLinkTarget).toHaveBeenCalledWith(ACME);
  });

  it("labels the plan and says how many rows already have the link", () => {
    render(<BulkBar bulk={api({ plan: ADD_PLAN, pending: { wouldApply: 3, unchanged: 2, warnings: [] } })} schema={SCHEMA} />);
    expect(screen.getByText("company + Acme")).toBeTruthy();
    expect(screen.getByText("3 row(s) would change")).toBeTruthy();
    expect(screen.getByText("2 already have that link")).toBeTruthy();
    cleanup();
    render(<BulkBar bulk={api({ plan: { ...ADD_PLAN, kind: "removeLink" }, pending: { wouldApply: 1, unchanged: 4, warnings: [] } })} schema={SCHEMA} />);
    expect(screen.getByText("company − Acme")).toBeTruthy();
    expect(screen.getByText("4 don't have that link")).toBeTruthy();
  });

  it("says which row was uncertain and how many weren't attempted after a failed request", () => {
    render(<BulkBar bulk={api({ outcome: { applied: 1, stale: 0, unchanged: 0, failed: 0, uncertain: 1, notAttempted: 2, error: "Engine unreachable" } })} schema={SCHEMA} />);
    expect(screen.getByText(/1 applied, 1 uncertain \(the request failed: Engine unreachable\), 2 not attempted/)).toBeTruthy();
  });

  it("reports unchanged and failed rows after the commit", () => {
    render(<BulkBar bulk={api({ outcome: { applied: 2, stale: 1, unchanged: 3, failed: 1 } })} schema={SCHEMA} />);
    expect(screen.getByText(/2 applied, 1 skipped \(changed elsewhere\), 3 unchanged, 1 failed/)).toBeTruthy();
  });
});
