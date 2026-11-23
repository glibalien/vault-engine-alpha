import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { makeSummaryDb,seedNode,seedRel } from '../helpers/summary-fixture.js';
import { summarizeNodes } from '../../src/summaries/service.js';
import type { SummaryData,SummaryRequest } from '../../src/summaries/types.js';
let db:Database.Database;
beforeEach(()=>{db=makeSummaryDb();}); afterEach(()=>{db.close();vi.restoreAllMocks();});
const req=():SummaryRequest=>({filter:{types:['project']},evaluation_context:{time_zone:'America/New_York',as_of:'2026-09-19T16:00:00Z'},relations:[{as:'r',direction:'incoming',field:'project',filter:{types:['task'],fields:{status:{one_of:['open','in-progress']},due:{date_window:{to_days:0}}}},metrics:[{as:'n',op:'count'}]}]});
const run=(r=req()):SummaryData=>JSON.parse(summarizeNodes(db,r).content[0].text).data;
it('counts overdue from complete active memberships and excludes due today',()=>{
 seedNode(db,'today',['task'],{status:'open',due:'2026-09-19'});seedRel(db,'today','P1','P1');
 expect(run().rows.map(x=>x.relations.r.metrics.n)).toEqual([1,1,0]);
 const r=req();r.relations[0].filter!.fields!.due={date_window:{from_days:0,to_days:7}};
 expect(run(r).rows.map(x=>x.relations.r.metrics.n)).toEqual([2,0,0]);
 expect(run(r).evaluation_context).toEqual({time_zone:'America/New_York',as_of:'2026-09-19T16:00:00.000Z',calendar_date:'2026-09-19'});
});
it('requires context for temporal filters and ignores malformed dates excluded by ordinary filters',()=>{
 const r=req();delete r.evaluation_context;expect(()=>run(r)).toThrow(/time_zone/);
 db.prepare("UPDATE node_fields SET value_text='BAD' WHERE node_id='T3' AND field_name='due'").run();
 expect(run().rows[0].relations.r.metrics.n).toBe(1);
});
it('rejects malformed eligible dates outside the displayed page without writing or exposing values',()=>{
 db.prepare("UPDATE node_fields SET value_text='PRIVATE BAD DATE' WHERE node_id='T2' AND field_name='due'").run();
 const r=req();r.limit=1;r.offset=2;const before=db.serialize();
 expect(()=>run(r)).toThrow(expect.objectContaining({code:'VALIDATION_FAILED',details:expect.objectContaining({node_id:'T2',field:'due'})}));
 try{run(r);}catch(e){expect(JSON.stringify(e)).not.toContain('PRIVATE BAD DATE');}
 expect(db.serialize()).toEqual(before);
});
it('preserves null markers over malformed legacy rows',()=>{
 db.prepare("INSERT INTO node_fields(node_id,field_name,value_json,source) VALUES ('T6','due','BAD','frontmatter')").run();
 expect(run().rows[1].relations.r.metrics.n).toBe(1);
});
it('handles parent-only and numerator-only temporal predicates',()=>{
 const r=req();delete r.relations[0].filter!.fields!.due;
 r.relations[0].metrics=[{as:'p',op:'percentage',matching_filter:{fields:{due:{date_window:{to_days:0}}}}}];
 expect(run(r).rows[0].relations.r.metrics.p).toBe(50);
 delete r.evaluation_context;expect(()=>run(r)).toThrow(/time_zone/);
 const parent=req();delete parent.relations[0].filter!.fields!.due;
 parent.filter={types:['project'],fields:{due:{date_window:{to_days:0}}}};
 db.prepare("INSERT INTO node_fields(node_id,field_name,value_text,source) VALUES ('P1','due','2026-09-18','frontmatter')").run();
 expect(run(parent).rows.map(x=>x.node.id)).toEqual(['P1']);
});
it('samples now once and reuses context across a changing database',()=>{
 const clock=vi.spyOn(Date,'now').mockReturnValueOnce(Date.parse('2026-09-20T03:59:59Z')).mockReturnValue(Date.parse('2026-09-20T04:00:01Z'));
 const r=req();delete r.evaluation_context!.as_of;const first=run(r);
 expect(clock).toHaveBeenCalledTimes(1);expect(first.evaluation_context!.calendar_date).toBe('2026-09-19');
 r.evaluation_context=first.evaluation_context && {as_of:first.evaluation_context.as_of,time_zone:first.evaluation_context.time_zone};
 db.prepare("UPDATE node_fields SET value_text='2026-09-21' WHERE node_id='T2' AND field_name='due'").run();
 expect(run(r).rows[0].relations.r.metrics.n).toBe(0);
 expect(clock).toHaveBeenCalledTimes(1);
});
it('validates all date fields despite a different temporal predicate rejecting membership',()=>{
 const r=req();r.relations[0].filter!.fields!.due={date_window:{from_days:100}};
 db.prepare("INSERT INTO global_fields(name,field_type) VALUES ('other_date','date')").run();
 db.prepare("INSERT INTO node_fields(node_id,field_name,value_text,source) VALUES ('T2','other_date','BAD','frontmatter')").run();
 r.relations[0].filter!.fields!.other_date={date_window:{to_days:0}};
 expect(()=>run(r)).toThrow(expect.objectContaining({details:expect.objectContaining({field:'other_date'})}));
});
