import { expect, it, vi } from 'vitest';
import { resolveEvaluationContext, resolveDateWindow, dateWindowMatches } from '../../src/summaries/temporal.js';
const context = (as_of='2026-09-20T00:30:00Z',time_zone='America/New_York') => resolveEvaluationContext({as_of,time_zone},true)!;
it('uses the named local date rather than the host or UTC day', () => {
 expect(context().calendar_date).toBe('2026-09-19');
 expect(context(undefined,'Asia/Tokyo').calendar_date).toBe('2026-09-20');
});
it('samples the clock only once when necessary', () => {
 const now=vi.fn(()=>Date.parse('2026-09-20T00:30:00Z'));
 expect(resolveEvaluationContext(undefined,false,now)).toBeUndefined();
 expect(now).not.toHaveBeenCalled();
 resolveEvaluationContext({time_zone:'UTC',as_of:'2026-09-20T00:30:00Z'},true,now);
 expect(now).not.toHaveBeenCalled();
 expect(resolveEvaluationContext({time_zone:'UTC'},true,now)?.calendar_date).toBe('2026-09-20');
 expect(now).toHaveBeenCalledTimes(1);
 expect(()=>resolveEvaluationContext(undefined,true,now)).toThrow(/time_zone/);
});
it.each([
 ['2026-03-08T16:00:00Z',0,7,'2026-03-08','2026-03-15'],
 ['2026-11-01T17:00:00Z',0,7,'2026-11-01','2026-11-08'],
 ['2024-02-28T17:00:00Z',0,2,'2024-02-28','2024-03-01'],
 ['2026-12-31T17:00:00Z',-1,2,'2026-12-30','2027-01-02'],
] as const)('uses calendar arithmetic at %s', (instant,from_days,to_days,from,to) => {
 expect(resolveDateWindow({from_days,to_days},context(instant))).toEqual({from,to});
});
it.each(['2026-02-30T12:00:00Z','2026-01-01','2026-01-01T12:00:00','2026-01-01T25:00:00Z','0000-01-01T00:00:00Z','2026-01-01T12:00:00+25:00'])('rejects invalid instants %s', as_of => expect(()=>context(as_of)).toThrow());
it.each(['bad/zone','+01:00',''])('rejects non-IANA timezone %s', zone => expect(()=>context(undefined,zone)).toThrow());
it('excludes due-today from overdue and uses an exclusive upper bound', () => {
 const c=context(), id={field:'due',node_id:'T'};
 expect(dateWindowMatches('2026-09-18',{to_days:0},c,id)).toBe(true);
 expect(dateWindowMatches('2026-09-19',{to_days:0},c,id)).toBe(false);
 expect(dateWindowMatches('2026-09-19',{from_days:0,to_days:7},c,id)).toBe(true);
 expect(dateWindowMatches('2026-09-26',{from_days:0,to_days:7},c,id)).toBe(false);
 for(const v of [null,undefined]) expect(dateWindowMatches(v,{to_days:0},c,id)).toBe(false);
 for(const v of ['2026-02-30','2026-09-18T00:00:00Z',' 2026-09-18',42,Symbol()])
  expect(()=>dateWindowMatches(v,{to_days:0},c,id)).toThrow(expect.objectContaining({code:'VALIDATION_FAILED',details:expect.objectContaining(id)}));
});
it('handles early years without 1900 coercion and rejects overflow', () => {
 expect(resolveDateWindow({from_days:0,to_days:1},context('0001-01-01T12:00:00Z','UTC'))).toEqual({from:'0001-01-01',to:'0001-01-02'});
 expect(()=>resolveDateWindow({from_days:-1},context('0001-01-01T12:00:00Z','UTC'))).toThrow();
 expect(()=>resolveDateWindow({to_days:1},context('9999-12-31T12:00:00Z','UTC'))).toThrow();
});
