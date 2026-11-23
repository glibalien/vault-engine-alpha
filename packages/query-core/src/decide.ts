/**
 * Smart-confirm decision over a real update-node dry-run envelope.
 * Spec: 2026-05-03-query-nodes-interactive-table-v1-design.md
 *       §"Smart-confirm decision logic".
 *
 * IMPORTANT — scoped to the EDITED field. The engine's dry-run returns
 * `coerced_state` for the WHOLE node and re-coerces every field on every edit
 * (e.g. existing date fields come back with `coercion_code: "STRING_TO_DATE"`)
 * and flags persistent orphans like the synthetic `title` field every time.
 * Scanning the whole map would therefore promote on essentially every edit, so
 * the decision only inspects the edited field's coerced state and orphans/errors
 * attributable to it. Verified against the live engine 2026-06-07.
 *
 * Two engine realities this encodes (confirmed via live dry-runs):
 *  1. A validation error (e.g. bad enum) comes back as `ok: true` with an
 *     error-severity issue in `warnings[]` (+ a `fixable` entry), NOT `ok:false`.
 *     When it's about the edited cell we keep the editor open (inline-error).
 *  2. A coercion only promotes when it's *surprising* — the coerced value differs
 *     from the raw input (e.g. "next friday" → a date). A no-op normalization
 *     where value === original (a clean ISO date / plain number) commits silently.
 */
import type { Envelope, UpdateDryRunData } from "./types.js";

export type Decision =
  | { decision: "commit"; reasons: string[] }
  | { decision: "promote"; reasons: string[]; error?: { code: string; message: string } }
  | { decision: "inline-error"; reasons: string[]; error: { code: string; message: string; field?: string } }
  | { decision: "stale"; reasons: string[] };

function errorField(env: Extract<Envelope<unknown>, { ok: false }>): string | undefined {
  const d = env.error.details as { field?: string } | undefined;
  if (d && typeof d.field === "string") return d.field;
  // fall back to a per-field warning
  const wf = env.warnings.find(w => w.field);
  return wf?.field;
}

export function decideUpdate(editedField: string, env: Envelope<UpdateDryRunData>): Decision {
  // ---- Hard failures (ok:false) ----------------------------------------
  if (!env.ok) {
    if (env.error.code === "STALE_NODE") return { decision: "stale", reasons: [env.error.message] };
    const f = errorField(env);
    if (f && f === editedField) {
      return { decision: "inline-error", reasons: [env.error.message], error: { ...env.error, field: f } };
    }
    return { decision: "promote", reasons: [env.error.message], error: env.error };
  }

  const pv = env.data.preview;

  // ---- Validation errors that surface on the edited cell as ok:true ------
  // (error-severity warning, or a fixable entry for the edited field) → keep the
  // editor open so the user can correct it, rather than a confirm pill.
  const editError = env.warnings.find(w => w.severity === "error" && w.field === editedField);
  if (editError) {
    return {
      decision: "inline-error",
      reasons: [editError.message],
      error: { code: editError.code, message: editError.message, field: editedField },
    };
  }
  const editFixable = pv.fixable.find(f => f.field === editedField);
  if (editFixable) {
    const msg = editFixable.allowed_values?.length
      ? `Not a valid value. Allowed: ${editFixable.allowed_values.join(", ")}.`
      : "This value needs fixing before it can be saved.";
    return {
      decision: "inline-error",
      reasons: [msg],
      error: { code: "VALIDATION_FAILED", message: msg, field: editedField },
    };
  }

  // ---- Promote signals, scoped to the edited field ----------------------
  const reasons: string[] = [];
  const st = pv.coerced_state[editedField];
  if (st) {
    if (st.source === "defaulted") reasons.push("A default value would be applied.");
    // Only a surprising coercion (result differs from the raw input) is notable.
    if (st.coercion_code && String(st.value) !== String(st.original ?? "")) {
      reasons.push(`Interpreted your input as “${String(st.value)}”.`);
    }
  }
  // Only orphans the edit itself introduced (the edited field isn't claimed by
  // the type's schema). Pre-existing orphans on other fields are noise.
  if (pv.orphan_fields.includes(editedField)) {
    reasons.push("Sets a field that isn't in this type's schema (orphan).");
  }
  // Remaining warnings (warning-severity, or error-severity on OTHER fields) are
  // edit-relevant signals worth surfacing — e.g. PENDING_REFERENCES.
  for (const w of env.warnings) {
    if (w.severity === "error" && w.field === editedField) continue; // already handled
    reasons.push(w.message);
  }

  // De-dupe, preserve order.
  const seen = new Set<string>();
  const deduped = reasons.filter(r => (seen.has(r) ? false : (seen.add(r), true)));
  return deduped.length ? { decision: "promote", reasons: deduped } : { decision: "commit", reasons: [] };
}
