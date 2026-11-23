import { describe, it, expect } from "vitest";
import { decideUpdate } from "../src/decide.js";
import type { Envelope, UpdateDryRunData, Issue, CoercedValue, FixableEntry } from "../src/types.js";

function dry(
  over: Partial<UpdateDryRunData["preview"]>,
  warnings: Issue[] = [],
): Envelope<UpdateDryRunData> {
  return {
    ok: true,
    data: { dry_run: true, preview: {
      node_id: "t-1", file_path: "t.md", title: "T", types: ["task"],
      coerced_state: {}, fixable: [], orphan_fields: [], ...over,
    } },
    warnings,
  };
}

const cs = (
  field: string,
  p: Partial<Pick<CoercedValue, "source" | "changed" | "coercion_code" | "value" | "original">>,
): Record<string, CoercedValue> => ({
  [field]: {
    field,
    value: p.value ?? "x",
    source: p.source ?? "provided",
    changed: p.changed ?? true,
    coercion_code: p.coercion_code,
    original: p.original,
  },
});

// A realistic whole-node dry-run preview: the engine re-coerces EVERY field on
// every edit (existing dates come back STRING_TO_DATE) and flags the synthetic
// `title` as a persistent orphan. The edited field's entry is merged on top.
function wholeNode(edited: Record<string, CoercedValue>): Partial<UpdateDryRunData["preview"]> {
  return {
    coerced_state: {
      date: { field: "date", value: "2026-05-19", source: "provided", changed: false },
      dateCreated: { field: "dateCreated", value: "2026-05-19T18:20:02-04:00", source: "provided", changed: true, original: "2026-05-19T18:20:02-04:00", coercion_code: "STRING_TO_DATE" },
      due: { field: "due", value: "2026-06-12", source: "provided", changed: true, original: "2026-06-12", coercion_code: "STRING_TO_DATE" },
      title: { field: "title", value: "T", source: "orphan", changed: false },
      ...edited,
    },
    orphan_fields: ["title"],
  };
}

describe("decideUpdate", () => {
  it("commits a clean enum change even when the whole-node preview re-coerces other date fields and flags the persistent `title` orphan", () => {
    // Regression for the over-promote bug: scanning the whole coerced_state /
    // orphan_fields would pill on every edit against real task nodes.
    const d = decideUpdate("status", dry(wholeNode(cs("status", { source: "provided", changed: false, value: "in-progress" }))));
    expect(d.decision).toBe("commit");
  });

  it("promotes when a default would be applied to the edited field", () => {
    const d = decideUpdate("status", dry(wholeNode(cs("status", { source: "defaulted", value: "open" }))));
    expect(d.decision).toBe("promote");
    expect(d.reasons.join(" ")).toMatch(/default/i);
  });

  it("promotes on a surprising coercion (fuzzy date where value != input)", () => {
    const d = decideUpdate("due", dry(wholeNode(cs("due", { coercion_code: "STRING_TO_DATE_FUZZY", original: "next friday", value: "2026-06-12" }))));
    expect(d.decision).toBe("promote");
    expect(d.reasons.join(" ")).toMatch(/2026-06-12/);
  });

  it("commits silently on a no-op coercion (clean ISO date where value == input)", () => {
    const d = decideUpdate("due", dry(wholeNode(cs("due", { coercion_code: "STRING_TO_DATE", original: "2026-07-01", value: "2026-07-01" }))));
    expect(d.decision).toBe("commit");
  });

  it("promotes on a warning-severity warning for the edited field", () => {
    const d = decideUpdate("assignee", dry(
      wholeNode(cs("assignee", { value: "New Person" })),
      [{ code: "PENDING_REFERENCES", message: "no such person", severity: "warning", field: "assignee" }],
    ));
    expect(d.decision).toBe("promote");
  });

  it("promotes when the EDITED field is newly orphaned (not pre-existing orphans)", () => {
    const d = decideUpdate("weird", dry({
      coerced_state: cs("weird", { source: "orphan" }),
      orphan_fields: ["weird", "title"],
    }));
    expect(d.decision).toBe("promote");
  });

  it("does NOT promote merely because an unrelated field is a pre-existing orphan", () => {
    // `title` is always an orphan; editing `status` cleanly must still commit.
    const d = decideUpdate("status", dry(wholeNode(cs("status", { source: "provided", changed: false, value: "done" }))));
    expect(d.decision).toBe("commit");
  });

  it("inline-errors on an ok:true ENUM_MISMATCH (error-severity warning) for the edited field", () => {
    // Regression for bug 2: the engine returns a bad enum as ok:true with an
    // error-severity warning + fixable, NOT ok:false. It must keep the editor open.
    const d = decideUpdate("status", dry(
      { coerced_state: wholeNode({}).coerced_state, orphan_fields: ["title"], fixable: [{ field: "status", suggestion: null, allowed_values: ["open", "done"] }] as FixableEntry[] },
      [{ code: "ENUM_MISMATCH", message: '"bogus" is not a valid enum value', severity: "error", field: "status" }],
    ));
    expect(d.decision).toBe("inline-error");
    expect((d as Extract<typeof d, { decision: "inline-error" }>).error.field).toBe("status");
  });

  it("inline-errors on a fixable entry for the edited field with no explicit error warning", () => {
    const d = decideUpdate("status", dry({
      coerced_state: {},
      fixable: [{ field: "status", suggestion: null, allowed_values: ["open", "done"] }] as FixableEntry[],
    }));
    expect(d.decision).toBe("inline-error");
    expect(d.reasons.join(" ")).toMatch(/open, done/);
  });

  it("inline-errors when ok:false with matching error.field", () => {
    const env: Envelope<UpdateDryRunData> = {
      ok: false,
      error: { code: "VALIDATION_FAILED", message: "bad enum", details: { field: "status" } },
      warnings: [{ code: "ENUM_MISMATCH", message: "not allowed", severity: "error", field: "status" }],
    };
    const d = decideUpdate("status", env);
    expect(d.decision).toBe("inline-error");
    expect((d as Extract<typeof d, { decision: "inline-error" }>).error.code).toBeDefined();
  });

  it("promotes (pill) when ok:false with no field correlation", () => {
    const env: Envelope<UpdateDryRunData> = {
      ok: false, error: { code: "INTERNAL_ERROR", message: "boom" }, warnings: [],
    };
    expect(decideUpdate("status", env).decision).toBe("promote");
  });

  it("does NOT inline-error for STALE_NODE (caller handles it)", () => {
    const env: Envelope<UpdateDryRunData> = {
      ok: false, error: { code: "STALE_NODE", message: "stale" }, warnings: [],
    };
    expect(decideUpdate("status", env).decision).toBe("stale");
  });
});
