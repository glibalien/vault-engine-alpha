import { describe, it, expect } from "vitest";
import { buildCreatedRow } from "../src/use-viz-draft.js";

describe("buildCreatedRow", () => {
  it("builds a VizRow from the create response + committed fields", () => {
    const row = buildCreatedRow(
      { node_id: "n1", file_path: "TaskNotes/Tasks/New Task.md" },
      "New Task",
      { status: "backlog", project: "Vault Engine" },
      "task",
    );
    expect(row).toEqual({
      id: "n1",
      title: "New Task",
      file_path: "TaskNotes/Tasks/New Task.md",
      types: ["task"],
      fields: { status: "backlog", project: "Vault Engine" },
    });
  });

  it("defaults file_path to '' when the response omits it", () => {
    const row = buildCreatedRow({ node_id: "n2" }, "T", {}, "note");
    expect(row.file_path).toBe("");
    expect(row.id).toBe("n2");
    expect(row.types).toEqual(["note"]);
  });
});
