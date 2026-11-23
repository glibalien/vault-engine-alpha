import {
  isLinkCountColumn, parseArgs, type ParsedArgs, type QueryArgs,
} from "@vault/query-core";
import { NAME_SORT_KEY, showsLinkCounts, withoutColumnSort, type VizSpec } from "./viz-spec.js";

/** Parse a spec's query into owned query state (strip + typeSelection + caller fragments). */
export function vizOwnedState(spec: VizSpec): ParsedArgs {
  return parseArgs(spec.query);
}

/** Return a new spec with its query replaced (immutable). */
export function vizWithQuery(spec: VizSpec, query: QueryArgs): VizSpec {
  return { ...spec, query };
}

/** Return a new spec with its display_fields replaced (immutable). A column sort on a removed
 *  column goes with it: the view would otherwise sort by a column it no longer shows. Name and the
 *  link-count columns aren't display fields, so a sort on either stays while it shows. */
export function vizWithDisplayFields(spec: VizSpec, fields: string[]): VizSpec {
  const sortField = spec.column_sort?.field;
  const keepSort = sortField === undefined || sortField === NAME_SORT_KEY || fields.includes(sortField)
    || (isLinkCountColumn(sortField) && showsLinkCounts(spec));
  return { ...(keepSort ? spec : withoutColumnSort(spec)), display_fields: fields };
}
