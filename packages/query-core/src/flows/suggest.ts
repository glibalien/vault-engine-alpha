/**
 * Reference-picker suggestion sourcing (pure builders; the async fetch lives
 * in app.ts via the Client). Empty query → recent nodes (file_mtime desc);
 * typing → title_contains. Scoped to the field's reference_target when
 * declared (advisory metadata — absent means suggest across all nodes).
 */
import type { NodeRow, QueryArgs, RefCandidate, SchemaField } from "../types.js";

export const SUGGEST_LIMIT = 10;

export function suggestArgs(field: SchemaField, query: string): QueryArgs {
  const args: QueryArgs = { limit: SUGGEST_LIMIT };
  if (field.reference_target) args.types = [field.reference_target];
  if (query) {
    args.title_contains = query;
  } else {
    args.sort_by = "file_mtime";
    args.sort_order = "desc";
  }
  return args;
}

export function toCandidates(rows: NodeRow[]): RefCandidate[] {
  return rows
    .filter((r): r is NodeRow & { title: string } => typeof r.title === "string")
    .map((r) => ({ id: r.id, title: r.title, types: r.types }));
}
