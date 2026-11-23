// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useVizJustCreated, mergeJustCreated } from "../src/use-viz-just-created.js";
import type { VizRow } from "../src/viz-spec.js";

const row = (id: string, title = id): VizRow => ({ id, title, file_path: "", types: ["task"], fields: {} });

describe("mergeJustCreated", () => {
  it("appends pinned rows not present in the query result and marks them justAdded", () => {
    const { rows, justAddedIds } = mergeJustCreated([row("a")], [row("b")]);
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect([...justAddedIds]).toEqual(["b"]);
  });
  it("dedups a pinned row the query already returns (query wins, no cue)", () => {
    const { rows, justAddedIds } = mergeJustCreated([row("a", "fresh")], [row("a", "stale")]);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("fresh");
    expect(justAddedIds.size).toBe(0);
  });
});

describe("useVizJustCreated", () => {
  it("adds a row and exposes it in pinnedRows", () => {
    const { result } = renderHook(() => useVizJustCreated("k1"));
    act(() => result.current.add(row("a")));
    expect(result.current.pinnedRows.map((r) => r.id)).toEqual(["a"]);
  });
  it("dedups by id within the pinned set", () => {
    const { result } = renderHook(() => useVizJustCreated("k1"));
    act(() => { result.current.add(row("a")); result.current.add(row("a")); });
    expect(result.current.pinnedRows).toHaveLength(1);
  });
  it("persists pins when queryKey is unchanged (the poll case)", () => {
    const { result, rerender } = renderHook(({ k }) => useVizJustCreated(k), { initialProps: { k: "k1" } });
    act(() => result.current.add(row("a")));
    rerender({ k: "k1" });
    expect(result.current.pinnedRows).toHaveLength(1);
  });
  it("clears pins when queryKey changes (re-filter)", () => {
    const { result, rerender } = renderHook(({ k }) => useVizJustCreated(k), { initialProps: { k: "k1" } });
    act(() => result.current.add(row("a")));
    rerender({ k: "k2" });
    expect(result.current.pinnedRows).toEqual([]);
  });
});
