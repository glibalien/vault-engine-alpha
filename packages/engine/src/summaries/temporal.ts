import { filterLeaves } from '../filters/expression.js';
import { z } from 'zod';
import { invalid, SummaryError } from './errors.js';
import { isStrictIsoDateString } from '../validation/date.js';
import type { DateWindow, EvaluationContext, EvaluationContextInput, SummaryFilter, SummaryRequest } from './types.js';

export const dateWindowSchema = z.object({
  from_days: z.number().int().min(-36600).max(36600).optional(),
  to_days: z.number().int().min(-36600).max(36600).optional(),
}).strict().refine(w => (w.from_days !== undefined || w.to_days !== undefined) &&
  (w.from_days === undefined || w.to_days === undefined || w.from_days < w.to_days), 'Date window must be nonempty and ordered');
const calendarDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && s.slice(0,4) !== '0000' && isStrictIsoDateString(s);
function validInstant(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(s) &&
    s.slice(0,4) !== '0000' && isStrictIsoDateString(s) && Number.isFinite(Date.parse(s));
}
function validZone(s: string): boolean {
  if (!s || /^[+-]/.test(s)) return false;
  try { new Intl.DateTimeFormat('en-US', {timeZone:s}); return true; } catch { return false; }
}
export const evaluationContextSchema = z.object({
  time_zone: z.string().min(1).max(1024).refine(validZone, 'A valid IANA time_zone is required'),
  as_of: z.string().max(128).refine(validInstant, 'as_of must be an RFC3339 instant with offset').optional(),
}).strict();
export function resolveEvaluationContext(input: EvaluationContextInput | undefined, required: boolean, now: () => number = Date.now): EvaluationContext | undefined {
  if (input === undefined) {
    if (required) invalid('Relative-date predicates require evaluation_context.time_zone.');
    return undefined;
  }
  const parsed = evaluationContextSchema.safeParse(input);
  if (!parsed.success) invalid('Invalid evaluation_context time_zone or as_of.');
  const instant = new Date(parsed.data.as_of ?? now());
  if (!Number.isFinite(instant.getTime()) || instant.getUTCFullYear() < 1 || instant.getUTCFullYear() > 9999) invalid('Evaluation instant is outside supported calendar range.');
  const parts = new Intl.DateTimeFormat('en-US', {timeZone:input.time_zone, calendar:'gregory', numberingSystem:'latn', era:'short', year:'numeric', month:'2-digit', day:'2-digit'}).formatToParts(instant);
  const part = (type: string) => parts.find(p=>p.type===type)?.value;
  const date = `${part('year')?.padStart(4,'0')}-${part('month')}-${part('day')}`;
  if (part('era') !== 'AD' || !calendarDate(date)) invalid('Evaluation date is outside supported calendar range.');
  return {time_zone:input.time_zone, as_of:instant.toISOString(), calendar_date:date};
}
export function hasDateWindows(filter: SummaryFilter): boolean {
  return [...filterLeaves(filter)].some(leaf=>Object.values(leaf.fields ?? {}).some(p => Object.hasOwn(p,'date_window')));
}
export function requestNeedsEvaluationContext(request: SummaryRequest): boolean {
  return hasDateWindows(request.filter ?? {}) || request.relations.some(r => hasDateWindows(r.filter ?? {}) ||
    r.metrics?.some(m => m.op === 'percentage' && hasDateWindows(m.matching_filter)));
}
export function resolveDateWindow(window: DateWindow, context: EvaluationContext): {from?:string;to?:string} {
  if (!dateWindowSchema.safeParse(window).success) invalid('Invalid date window.');
  const shift = (days: number) => {
    const d = new Date(`${context.calendar_date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate()+days);
    if (!Number.isFinite(d.getTime()) || d.getUTCFullYear()<1 || d.getUTCFullYear()>9999) invalid('Date window exceeds supported calendar range.');
    return d.toISOString().slice(0,10);
  };
  return {...(window.from_days === undefined ? {} : {from:shift(window.from_days)}),
    ...(window.to_days === undefined ? {} : {to:shift(window.to_days)})};
}
export function dateWindowMatches(value: unknown, window: DateWindow, context: EvaluationContext, identity: {field:string;node_id:string}): boolean {
  const bounds=resolveDateWindow(window,context);
  if (value === undefined || value === null) return false;
  if (typeof value !== 'string' || !calendarDate(value)) throw new SummaryError('VALIDATION_FAILED','Invalid stored calendar date.',{reason:'INVALID_AGGREGATE_VALUE',...identity});
  return (bounds.from === undefined || value >= bounds.from) && (bounds.to === undefined || value < bounds.to);
}
