// @vitest-environment jsdom
/**
 * VizSettings.test.tsx
 *
 * TDD tests for:
 * (a) VizSettings — density segmented control + row-numbers + version toggles call onSpecChange correctly
 * (b) VizTable — density class, row-number column, version column
 * (c) Backward compat — a spec without the new fields renders as today (no extra columns, default density)
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VizSettings } from "../src/VizSettings.js";
import { VizTable } from "../src/VizTable.js";
import type { VizRow, VizSpec } from "../src/viz-spec.js";

afterEach(() => cleanup());

// ---- shared fixtures ----

const BASE_SPEC: VizSpec = {
  kind: "table",
  title: "Test",
  query: { types: ["task"] },
  display_fields: ["status"],
};

const ROWS: VizRow[] = [
  { id: "r1", title: "Alpha", file_path: "a.md", types: ["task"], fields: { status: "open" }, version: 3 },
  { id: "r2", title: "Beta", file_path: "b.md", types: ["task"], fields: { status: "done" }, version: 7 },
];

// ---- VizSettings: button renders ----

describe("VizSettings — button", () => {
  it("renders a settings button", () => {
    render(
      <VizSettings spec={BASE_SPEC} onSpecChange={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: /settings/i })).toBeDefined();
  });

  it("popover is closed by default", () => {
    render(
      <VizSettings spec={BASE_SPEC} onSpecChange={vi.fn()} />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("clicking the button opens the popover", () => {
    render(
      <VizSettings spec={BASE_SPEC} onSpecChange={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /settings/i }));
    expect(screen.getByRole("dialog")).toBeDefined();
  });

  it("clicking the button again closes the popover", () => {
    render(
      <VizSettings spec={BASE_SPEC} onSpecChange={vi.fn()} />,
    );
    const btn = screen.getByRole("button", { name: /settings/i });
    fireEvent.click(btn);
    expect(screen.getByRole("dialog")).toBeDefined();
    fireEvent.click(btn);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

// ---- VizSettings: density segmented control ----

describe("VizSettings — density", () => {
  it("shows three density buttons", () => {
    render(<VizSettings spec={BASE_SPEC} onSpecChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /settings/i }));
    expect(screen.getByRole("button", { name: /compact/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /cozy/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /comfy/i })).toBeDefined();
  });

  it("default active density is cozy when spec.density is undefined", () => {
    render(<VizSettings spec={BASE_SPEC} onSpecChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /settings/i }));
    const cozy = screen.getByRole("button", { name: /cozy/i }) as HTMLButtonElement;
    expect(cozy.getAttribute("aria-pressed")).toBe("true");
    const compact = screen.getByRole("button", { name: /compact/i }) as HTMLButtonElement;
    expect(compact.getAttribute("aria-pressed")).toBe("false");
  });

  it("active density reflects spec.density", () => {
    render(<VizSettings spec={{ ...BASE_SPEC, density: "compact" }} onSpecChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /settings/i }));
    const compact = screen.getByRole("button", { name: /compact/i }) as HTMLButtonElement;
    expect(compact.getAttribute("aria-pressed")).toBe("true");
    const cozy = screen.getByRole("button", { name: /cozy/i }) as HTMLButtonElement;
    expect(cozy.getAttribute("aria-pressed")).toBe("false");
  });

  it("clicking compact calls onSpecChange with density: compact", () => {
    const onSpecChange = vi.fn();
    render(<VizSettings spec={BASE_SPEC} onSpecChange={onSpecChange} />);
    fireEvent.click(screen.getByRole("button", { name: /settings/i }));
    fireEvent.click(screen.getByRole("button", { name: /compact/i }));
    expect(onSpecChange).toHaveBeenCalledOnce();
    const next: VizSpec = onSpecChange.mock.calls[0][0];
    expect(next.density).toBe("compact");
    // other fields preserved
    expect(next.title).toBe(BASE_SPEC.title);
    expect(next.display_fields).toEqual(BASE_SPEC.display_fields);
  });

  it("clicking comfy calls onSpecChange with density: comfy", () => {
    const onSpecChange = vi.fn();
    render(<VizSettings spec={BASE_SPEC} onSpecChange={onSpecChange} />);
    fireEvent.click(screen.getByRole("button", { name: /settings/i }));
    fireEvent.click(screen.getByRole("button", { name: /comfy/i }));
    expect(onSpecChange).toHaveBeenCalledOnce();
    const next: VizSpec = onSpecChange.mock.calls[0][0];
    expect(next.density).toBe("comfy");
  });
});

// ---- VizSettings: row-numbers toggle ----

describe("VizSettings — row-numbers", () => {
  it("renders a row-numbers checkbox", () => {
    render(<VizSettings spec={BASE_SPEC} onSpecChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /settings/i }));
    expect(screen.getByRole("checkbox", { name: /row numbers/i })).toBeDefined();
  });

  it("row-numbers checkbox is unchecked by default", () => {
    render(<VizSettings spec={BASE_SPEC} onSpecChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /settings/i }));
    const cb = screen.getByRole("checkbox", { name: /row numbers/i }) as HTMLInputElement;
    expect(cb.checked).toBe(false);
  });

  it("row-numbers checkbox reflects spec.show_row_numbers=true", () => {
    render(<VizSettings spec={{ ...BASE_SPEC, show_row_numbers: true }} onSpecChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /settings/i }));
    const cb = screen.getByRole("checkbox", { name: /row numbers/i }) as HTMLInputElement;
    expect(cb.checked).toBe(true);
  });

  it("checking row-numbers calls onSpecChange with show_row_numbers: true", () => {
    const onSpecChange = vi.fn();
    render(<VizSettings spec={BASE_SPEC} onSpecChange={onSpecChange} />);
    fireEvent.click(screen.getByRole("button", { name: /settings/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /row numbers/i }));
    expect(onSpecChange).toHaveBeenCalledOnce();
    const next: VizSpec = onSpecChange.mock.calls[0][0];
    expect(next.show_row_numbers).toBe(true);
  });

  it("unchecking row-numbers calls onSpecChange with show_row_numbers: false", () => {
    const onSpecChange = vi.fn();
    render(<VizSettings spec={{ ...BASE_SPEC, show_row_numbers: true }} onSpecChange={onSpecChange} />);
    fireEvent.click(screen.getByRole("button", { name: /settings/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /row numbers/i }));
    expect(onSpecChange).toHaveBeenCalledOnce();
    const next: VizSpec = onSpecChange.mock.calls[0][0];
    expect(next.show_row_numbers).toBe(false);
  });
});

// ---- VizSettings: version toggle ----

describe("VizSettings — version", () => {
  it("renders a version checkbox", () => {
    render(<VizSettings spec={BASE_SPEC} onSpecChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /settings/i }));
    expect(screen.getByRole("checkbox", { name: /version/i })).toBeDefined();
  });

  it("version checkbox is unchecked by default", () => {
    render(<VizSettings spec={BASE_SPEC} onSpecChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /settings/i }));
    const cb = screen.getByRole("checkbox", { name: /version/i }) as HTMLInputElement;
    expect(cb.checked).toBe(false);
  });

  it("checking version calls onSpecChange with show_version: true", () => {
    const onSpecChange = vi.fn();
    render(<VizSettings spec={BASE_SPEC} onSpecChange={onSpecChange} />);
    fireEvent.click(screen.getByRole("button", { name: /settings/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /version/i }));
    expect(onSpecChange).toHaveBeenCalledOnce();
    const next: VizSpec = onSpecChange.mock.calls[0][0];
    expect(next.show_version).toBe(true);
  });

  it("unchecking version calls onSpecChange with show_version: false", () => {
    const onSpecChange = vi.fn();
    render(<VizSettings spec={{ ...BASE_SPEC, show_version: true }} onSpecChange={onSpecChange} />);
    fireEvent.click(screen.getByRole("button", { name: /settings/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /version/i }));
    expect(onSpecChange).toHaveBeenCalledOnce();
    const next: VizSpec = onSpecChange.mock.calls[0][0];
    expect(next.show_version).toBe(false);
  });
});

// ---- VizSettings: click-outside closes ----

describe("VizSettings — click-outside", () => {
  it("clicking outside the open popover closes it", () => {
    render(<VizSettings spec={BASE_SPEC} onSpecChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /settings/i }));
    expect(screen.getByRole("dialog")).toBeDefined();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

// ---- VizTable: density class ----

describe("VizTable — density class", () => {
  it("applies viz-density-cozy class by default (no density prop)", () => {
    const html = renderToStaticMarkup(
      createElement(VizTable, { rows: ROWS, displayFields: ["status"], groupField: "status" }),
    );
    expect(html).toContain("viz-density-cozy");
  });

  it("applies viz-density-compact class when density=compact", () => {
    const html = renderToStaticMarkup(
      createElement(VizTable, { rows: ROWS, displayFields: ["status"], groupField: "status", density: "compact" }),
    );
    expect(html).toContain("viz-density-compact");
  });

  it("applies viz-density-comfy class when density=comfy", () => {
    const html = renderToStaticMarkup(
      createElement(VizTable, { rows: ROWS, displayFields: ["status"], groupField: "status", density: "comfy" }),
    );
    expect(html).toContain("viz-density-comfy");
  });
});

// ---- VizTable: row-number column ----

describe("VizTable — row-number column", () => {
  it("renders no # column by default", () => {
    const html = renderToStaticMarkup(
      createElement(VizTable, { rows: ROWS, displayFields: ["status"], groupField: "status" }),
    );
    expect(html).not.toContain(">#<");
    expect(html).not.toContain('>#</');
    // no c-rownum class
    expect(html).not.toContain("c-rownum");
  });

  it("renders no # column when show_row_numbers=false", () => {
    const html = renderToStaticMarkup(
      createElement(VizTable, { rows: ROWS, displayFields: ["status"], groupField: "status", showRowNumbers: false }),
    );
    expect(html).not.toContain("c-rownum");
  });

  it("renders a # header and row indices when show_row_numbers=true", () => {
    const html = renderToStaticMarkup(
      createElement(VizTable, { rows: ROWS, displayFields: ["status"], groupField: "status", showRowNumbers: true }),
    );
    expect(html).toContain("c-rownum");
    // row numbers 1 and 2
    expect(html).toMatch(/c-rownum[^>]*>1</);
    expect(html).toMatch(/c-rownum[^>]*>2</);
  });
});

// ---- VizTable: version column ----

describe("VizTable — version column", () => {
  it("renders no version column by default", () => {
    const html = renderToStaticMarkup(
      createElement(VizTable, { rows: ROWS, displayFields: ["status"], groupField: "status" }),
    );
    expect(html).not.toContain("c-version");
  });

  it("renders no version column when show_version=false", () => {
    const html = renderToStaticMarkup(
      createElement(VizTable, { rows: ROWS, displayFields: ["status"], groupField: "status", showVersion: false }),
    );
    expect(html).not.toContain("c-version");
  });

  it("renders a version header and version values when show_version=true", () => {
    const html = renderToStaticMarkup(
      createElement(VizTable, { rows: ROWS, displayFields: ["status"], groupField: "status", showVersion: true }),
    );
    expect(html).toContain("c-version");
    expect(html).toContain(">3<");
    expect(html).toContain(">7<");
  });
});

// ---- Backward compat: spec without new fields ----

describe("VizTable — backward compat", () => {
  it("spec without new fields renders identically: no extra columns, default density", () => {
    // No density, show_row_numbers, show_version — should produce exactly: Title + status columns
    const html = renderToStaticMarkup(
      createElement(VizTable, { rows: ROWS, displayFields: ["status"], groupField: "status" }),
    );
    // Has title and status columns
    expect(html).toContain("Alpha");
    expect(html).toContain("open");
    // Default density
    expect(html).toContain("viz-density-cozy");
    // No extra columns
    expect(html).not.toContain("c-rownum");
    expect(html).not.toContain("c-version");
  });
});
