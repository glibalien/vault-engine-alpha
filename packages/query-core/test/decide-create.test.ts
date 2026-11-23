import { describe, it, expect } from "vitest";
import { decideCreate } from "../src/decide-create.js";
import type { Envelope, CreateDryRunData, Issue, CoercedValue, FixableEntry } from "../src/types.js";

function dry(
  over: Partial<CreateDryRunData["would_create"]>,
  warnings: Issue[] = [],
): Envelope<CreateDryRunData> {
  return {
    ok: true,
    data: { dry_run: true, would_create: {
      file_path: "Tasks/X.md", title: "X", types: ["task"],
      coerced_state: {}, fixable: [], orphan_fields: [], ...over,
    } },
    warnings,
  };
}

const cs = (field: string, p: Partial<CoercedValue>): Record<string, CoercedValue> => ({
  [field]: { field, value: p.value ?? "x", source: p.source ?? "provided", changed: p.changed ?? true, coercion_code: p.coercion_code, original: p.original },
});

describe("decideCreate", () => {
  it("commits a clean create (no coercions, no warnings)", () => {
    expect(decideCreate(dry({ coerced_state: cs("status", { changed: false, value: "open" }) })).decision).toBe("create");
  });

  it("does NOT promote merely because a default was applied (defaults are normal at creation)", () => {
    expect(decideCreate(dry({ coerced_state: cs("status", { source: "defaulted", value: "open" }) })).decision).toBe("create");
  });

  it("inline-errors on a file-path conflict (scoped to title)", () => {
    const d = decideCreate(dry({ conflict: 'File "Tasks/X.md" already exists' }));
    expect(d.decision).toBe("inline-error");
    expect((d as Extract<typeof d, { decision: "inline-error" }>).error.field).toBe("__title__");
  });

  it("inline-errors on a REQUIRED_MISSING error-severity warning, scoped to that field", () => {
    const d = decideCreate(dry({}, [{ code: "REQUIRED_MISSING", message: "priority is required", severity: "error", field: "priority" }]));
    expect(d.decision).toBe("inline-error");
    expect((d as Extract<typeof d, { decision: "inline-error" }>).error.field).toBe("priority");
  });

  it("inline-errors on a fixable entry (bad enum) scoped to that field", () => {
    const d = decideCreate(dry({ fixable: [{ field: "status", suggestion: null, allowed_values: ["open", "done"] }] as FixableEntry[] }));
    expect(d.decision).toBe("inline-error");
    expect(d.reasons.join(" ")).toMatch(/open, done/);
  });

  it("promotes on a surprising coercion (fuzzy date where value != input)", () => {
    const d = decideCreate(dry({ coerced_state: cs("due", { coercion_code: "STRING_TO_DATE_FUZZY", original: "next friday", value: "2026-06-12" }) }));
    expect(d.decision).toBe("promote");
    expect(d.reasons.join(" ")).toMatch(/2026-06-12/);
  });

  it("commits silently on a no-op coercion (clean ISO date where value == input)", () => {
    expect(decideCreate(dry({ coerced_state: cs("due", { coercion_code: "STRING_TO_DATE", original: "2026-07-01", value: "2026-07-01" }) })).decision).toBe("create");
  });

  it("promotes on a warning-severity warning", () => {
    const d = decideCreate(dry({}, [{ code: "PENDING_REFERENCES", message: "no such project", severity: "warning", field: "project" }]));
    expect(d.decision).toBe("promote");
    expect(d.reasons.join(" ")).toMatch(/no such project/);
  });

  it("inline-errors on ok:false (defensive), scoped to title when no field given", () => {
    const env: Envelope<CreateDryRunData> = { ok: false, error: { code: "INTERNAL_ERROR", message: "boom" }, warnings: [] };
    const d = decideCreate(env);
    expect(d.decision).toBe("inline-error");
    expect((d as Extract<typeof d, { decision: "inline-error" }>).error.field).toBe("__title__");
  });
});
