/**
 * Seed a new-node draft's field values from the active query filters, so a node
 * created in a filtered query-nodes view defaults to satisfying those filters
 * (and stays visible after refresh) instead of "disappearing".
 *
 * Best-effort: emits field→value ONLY for filters that pin exactly one positive
 * value — reference link chips, single-value enum chips, bool chips, and
 * outgoing `references` caller fragments. Everything ambiguous or negative
 * (ranges, text, multi-value, exists, negations, incoming refs, foreign joins,
 * tags) is skipped.
 *
 * Pure: no DOM, no UiState mutation — startDraft assigns the result to
 * draft.fields. The seeded reference value is the target's TITLE string, the
 * same value the inline ref editor submits (_kit/cell-edit.ts), which the engine
 * resolves to a [[wikilink]] + relationship whose target matches the filter.
 *
 * Spec: docs/superpowers/specs/2026-06-17-query-nodes-seed-draft-from-filters-design.md
 */
import type { CallerFragment, FilterChip, Schema } from "../types.js";
import { widgetForField } from "../schema.js";

export function seedFieldsFromFilters(
  schema: Schema,
  chips: FilterChip[],
  fragments: CallerFragment[],
): Record<string, unknown> {
  const seed: Record<string, unknown> = {};

  // Chips first — they win any later collision with a references fragment.
  for (const chip of chips) {
    const field = schema.fields.find(f => f.name === chip.field);
    if (!field) continue;
    const st = chip.state;
    const w = widgetForField(field);

    if (w === "link") {
      // exists:true/false is a presence filter (no single target to seed); only
      // a pinned + hydrated target seeds a value.
      if (st.exists === true || st.exists === false) continue;
      const target = st.target as { id?: unknown; title?: unknown } | null | undefined;
      if (target && typeof target.id === "string" && typeof target.title === "string" && target.title !== "") {
        seed[chip.field] = target.title;
      }
    } else if (w === "enum") {
      // Multi-value one_of: the first value still satisfies a membership filter.
      const vals = Array.isArray(st.one_of) ? st.one_of : [];
      if (vals.length >= 1) seed[chip.field] = vals[0];
    } else if (w === "bool") {
      if (typeof st.eq === "boolean") seed[chip.field] = st.eq;
    } else if (w === "tags") {
      // tags chip state is { value: T } ("has T"); seed a one-tag list.
      if (typeof st.value === "string" && st.value !== "") seed[chip.field] = [st.value];
    }
    // number ({min,max}) / date ({gte,lte}) / text ({contains}) widgets: no single
    // positive value (range/substring) → skip; the optimistic-keep covers visibility.
  }

  // `references` caller fragments: seed only an outgoing ref whose rel_type names
  // a link-widget field, and never overwrite a field a chip already seeded.
  for (const f of fragments) {
    if (f.key !== "references") continue;
    const p = (f.payload && typeof f.payload === "object" ? f.payload : {}) as Record<string, unknown>;
    if (p.direction !== undefined && p.direction !== "outgoing") continue;
    const rel = p.rel_type;
    const target = p.target;
    if (typeof rel !== "string" || typeof target !== "string" || target === "") continue;
    if (rel in seed) continue; // chip already seeded this field
    const field = schema.fields.find(sf => sf.name === rel);
    if (!field || widgetForField(field) !== "link") continue;
    seed[rel] = target;
  }

  return seed;
}
