/**
 * Smart-confirm decision over a `create-node` dry-run envelope.
 * Sibling of decide.ts (the update-node decider), adapted to the
 * `would_create` shape. Verified against the live create-node tool 2026-06-08.
 *
 * Differences from decideUpdate (deliberate):
 *  - NOT field-scoped. create-node only coerces the fields we provide (+ defaults),
 *    so there is no whole-node re-coercion noise to filter — every changed field is
 *    a real signal.
 *  - Does NOT promote on source:"defaulted". Default population is the normal,
 *    expected path at node creation (creation-only defaults), so promoting on it
 *    would pill on essentially every create.
 *  - A file-path `conflict` and validation problems (REQUIRED_MISSING error-severity
 *    warning, or a `fixable` entry) become inline-errors that keep the draft open.
 */
import type { Envelope, CreateDryRunData, DraftError } from "./types.js";
import { TITLE_FIELD } from "./types.js";

export type CreateDecision =
  | { decision: "create"; reasons: string[] }
  | { decision: "promote"; reasons: string[] }
  | { decision: "inline-error"; reasons: string[]; error: DraftError };

export function decideCreate(env: Envelope<CreateDryRunData>): CreateDecision {
  // ---- Hard failure (defensive — create-node dry-run is normally ok:true) ----
  if (!env.ok) {
    const field =
      (env.error.details as { field?: string } | undefined)?.field ??
      env.warnings.find(w => w.field)?.field ??
      TITLE_FIELD;
    return { decision: "inline-error", reasons: [env.error.message], error: { code: env.error.code, message: env.error.message, field } };
  }

  const wc = env.data.would_create;

  // ---- File-path conflict → keep draft open on the title ----
  if (wc.conflict) {
    return { decision: "inline-error", reasons: [wc.conflict], error: { code: "FILE_EXISTS", message: wc.conflict, field: TITLE_FIELD } };
  }

  // ---- Validation errors (ok:true) → inline error on the offending field ----
  const errW = env.warnings.find(w => w.severity === "error");
  if (errW) {
    return { decision: "inline-error", reasons: [errW.message], error: { code: errW.code, message: errW.message, field: errW.field ?? TITLE_FIELD } };
  }
  const fix = wc.fixable[0];
  if (fix) {
    const msg = fix.allowed_values?.length
      ? `Not a valid value. Allowed: ${fix.allowed_values.join(", ")}.`
      : "This value needs fixing before it can be saved.";
    return { decision: "inline-error", reasons: [msg], error: { code: "VALIDATION_FAILED", message: msg, field: fix.field } };
  }

  // ---- Promote signals ----
  const reasons: string[] = [];
  for (const [f, st] of Object.entries(wc.coerced_state)) {
    // Only a surprising coercion (result differs from the raw input) is notable.
    if (st.changed && st.coercion_code && String(st.value) !== String(st.original ?? "")) {
      reasons.push(`Interpreted ${f} as "${String(st.value)}".`);
    }
  }
  for (const f of wc.orphan_fields) {
    reasons.push(`Sets a field not in this type's schema: ${f}.`);
  }
  for (const w of env.warnings) {
    if (w.severity === "error") continue; // handled above
    reasons.push(w.message);
  }

  const seen = new Set<string>();
  const deduped = reasons.filter(r => (seen.has(r) ? false : (seen.add(r), true)));
  return deduped.length ? { decision: "promote", reasons: deduped } : { decision: "create", reasons: [] };
}
