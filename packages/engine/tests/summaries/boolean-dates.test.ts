import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { makeSummaryDb } from '../helpers/summary-fixture.js';
import { summarizeNodes } from '../../src/summaries/service.js';
import type { SummaryFilter, SummaryFilterLeaf, SummaryRequest } from '../../src/summaries/types.js';
let db:Database.Database;
beforeEach(()=>{db=makeSummaryDb();});afterEach(()=>{db.close();vi.useRealTimers();});
const open:SummaryFilterLeaf={fields:{status:{eq:'open'}}};
const high:SummaryFilterLeaf={fields:{estimate:{gt:1}}};
const due:SummaryFilterLeaf={fields:{due:{date_window:{to_days:0}}}};
const context={time_zone:'America/New_York',as_of:'2026-09-20T02:13:18Z'};
const request=(where:NonNullable<SummaryFilter['where']>):SummaryRequest=>({evaluation_context:context,filter:{node_ids:['P1']},relations:[{as:'work',direction:'incoming',field:'project',filter:{where},metrics:[{as:'n',op:'count'}]}]});
const run=(r:SummaryRequest)=>JSON.parse(summarizeNodes(db,r).content[0].text).data;
function bad(id:string){db.prepare("UPDATE node_fields SET value_text=? WHERE node_id=? AND field_name='due'").run('BAD-PRIVATE-DATE',id);}
it.each([false,true])('validates eligible dates even when an OR branch succeeds, reverse=%s',reverse=>{
  bad('T1');const branches=reverse?[due,high]:[high,due];
  let error:unknown;try{run(request({all:[open,{any:branches}]}));}catch(e){error=e;}
  expect(error).toMatchObject({code:'VALIDATION_FAILED',details:expect.objectContaining({node_id:'T1',field:'due'})});
  expect(JSON.stringify(error)).not.toContain('BAD-PRIVATE-DATE');
});
it.each([false,true])('does not validate dates outside ordinary branch eligibility, reverse=%s',reverse=>{
  bad('T3');const branches:NonNullable<SummaryFilter['where']>[]=[{fields:{status:{eq:'done'}}},{all:[open,due]}];
  expect(run(request({any:reverse?branches.reverse():branches})).rows[0].relations.work.metrics.n).toBe(1);
});
it('requires context structurally even for an empty temporal branch',()=>{
  const r=request({any:[{node_ids:['T1']},{all:[{node_ids:['absent']},due]}]});delete r.evaluation_context;
  expect(()=>run(r)).toThrow(/evaluation_context/);
});
it('treats missing and explicit-null dates as nonmatching and reuses one calendar context',()=>{
  const r=request({all:[open,due]});r.filter={node_ids:['P2']};
  expect(run(r).rows[0].relations.work.metrics.n).toBe(0);
  vi.useFakeTimers();vi.setSystemTime(new Date(context.as_of));r.evaluation_context={time_zone:'America/New_York'};
  expect(run(r).evaluation_context).toEqual({...context,as_of:'2026-09-20T02:13:18.000Z',calendar_date:'2026-09-19'});
});
it('validates numerator dates only within the final denominator',()=>{
  bad('T3');const r=request({node_ids:['T1']});r.relations[0].metrics=[{as:'pct',op:'percentage',matching_filter:{where:{any:[{fields:{estimate:{gt:1}}},due]}}}];
  expect(run(r).rows[0].relations.work.metrics.pct).toBe(100);
});
it('does not hide malformed parent dates beyond the displayed page',()=>{
  bad('T3');const r=request({node_ids:['P1']});r.filter={types:['task'],where:{any:[{node_ids:['T1']},due]}};r.limit=1;
  expect(()=>run(r)).toThrow(expect.objectContaining({details:expect.objectContaining({node_id:'T3'})}));
});
