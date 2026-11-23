import { afterEach, beforeEach, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { makeSummaryDb } from '../helpers/summary-fixture.js';
import { parseSummaryRequest, validateSummaryRequest } from '../../src/summaries/input.js';
let db: Database.Database;
beforeEach(() => { db = makeSummaryDb(); });
afterEach(() => db.close());
const request = () => ({ relations: [{ as: 'work', direction: 'incoming', field: 'project',
 filter: { fields: { due: { date_window: { to_days: 0 } } } },
 metrics: [{ as: 'completion', op: 'percentage', matching_filter: { fields: { status: { eq: 'done' } } } }] }] });
it('discovers typed percentage and relative filters without sampling a runtime clock', () => {
 const parsed = parseSummaryRequest(request());
 const result = validateSummaryRequest(db, parsed);
 expect(result.definitions[0].metrics[0]).toMatchObject({op:'percentage',type:'number',nullable:true,unit:'percent'});
});
it('accepts explicit clock context and preserves it', () => {
 const evaluation_context = {time_zone:'America/New_York',as_of:'2026-09-19T16:00:00Z'};
 expect(parseSummaryRequest({...request(),evaluation_context})).toHaveProperty('evaluation_context',evaluation_context);
});
it.each([{}, {from_days:0,to_days:0}, {from_days:2,to_days:1}, {to_days:1.5}, {to_days:36601}, {from_days:-36601}])('rejects invalid date windows %j', window => {
 const r=request(); r.relations[0].filter.fields.due.date_window=window as {to_days:number};
 expect(() => parseSummaryRequest(r)).toThrow();
});
it('rejects date windows on a non-date field', () => {
 const r=request(); const parsed = parseSummaryRequest({...r,filter:{fields:{status:{date_window:{to_days:0}}}}});
 expect(() => validateSummaryRequest(db,parsed)).toThrow(/date/i);
});
it('restricts numerator filters to field predicates', () => {
 const r=request(); Object.assign(r.relations[0].metrics[0].matching_filter,{types:['task']});
 expect(() => parseSummaryRequest(r)).toThrow();
});
