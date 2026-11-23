// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { VizTable } from "../src/VizTable.js";
import type { VizRow } from "../src/viz-spec.js";

afterEach(cleanup);

const row = (id: string): VizRow => ({ id, title: id, file_path: "", types: ["task"], fields: {} });

describe("VizTable — just-added cue", () => {
  it("adds the viz-just-added class only to rows in justAddedIds", () => {
    const { container } = render(
      <VizTable rows={[row("a"), row("b")]} displayFields={[]} justAddedIds={new Set(["b"])} />,
    );
    const trs = container.querySelectorAll("tbody tr");
    expect(trs).toHaveLength(2);
    expect(trs[0].className).not.toContain("viz-just-added");
    expect(trs[1].className).toContain("viz-just-added");
  });

  it("adds no cue when justAddedIds is omitted", () => {
    const { container } = render(<VizTable rows={[row("a")]} displayFields={[]} />);
    expect(container.querySelector("tbody tr")?.className ?? "").not.toContain("viz-just-added");
  });
});
