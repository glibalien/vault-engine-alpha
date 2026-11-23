import { createFieldMap } from '../fields/field-map.js';
import { dateWindowMatches, resolveDateWindow } from './temporal.js';
import type { DateWindow, EvaluationContext, SummaryFilter, SummaryFilterLeaf, SummaryPredicate } from './types.js';
export type StaticSummaryFilter = Omit<SummaryFilterLeaf,'fields'> & {fields?:Record<string,Exclude<SummaryPredicate,{date_window:DateWindow}>>};
export function splitDateWindows(filter:SummaryFilter): {ordinary:StaticSummaryFilter;windows:Record<string,DateWindow>} {
  const {fields,...base}=filter;
  const ordinaryFields=createFieldMap<Exclude<SummaryPredicate,{date_window:DateWindow}>>();
  const windows=createFieldMap<DateWindow>();
  for(const [name,predicate] of Object.entries(fields ?? {})) {
    if ('date_window' in predicate) windows[name]=predicate.date_window;
    else ordinaryFields[name]=predicate;
  }
  return {ordinary:{...base,...(fields === undefined ? {} : {fields:ordinaryFields})},windows};
}
export function filterCalendarIds(ids:readonly string[],windows:Record<string,DateWindow>,fields:ReadonlyMap<string,Record<string,unknown>>,context:EvaluationContext):Set<string> {
  const entries=Object.entries(windows);
  for(const [,window] of entries) resolveDateWindow(window,context);
  const result=new Set<string>();
  for(const id of ids) {
    let matches=true;
    const row=fields.get(id);
    for(const [field,window] of entries) {
      const value=row && Object.hasOwn(row,field) ? row[field] : undefined;
      // Do not short circuit: every temporal field in the eligible population is validated.
      if(!dateWindowMatches(value,window,context,{field,node_id:id})) matches=false;
    }
    if(matches) result.add(id);
  }
  return result;
}
