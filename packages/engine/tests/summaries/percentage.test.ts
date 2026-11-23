import { afterEach, beforeEach, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { makeSummaryDb, seedRel } from '../helpers/summary-fixture.js';
import { summarizeNodes } from '../../src/summaries/service.js';
import { percentageOf } from '../../src/summaries/percentage.js';
import type { SummaryData, SummaryRequest } from '../../src/summaries/types.js';
let db: Database.Database;
beforeEach(()=>{db=makeSummaryDb();}); afterEach(()=>db.close());
const req=():SummaryRequest=>({filter:{types:['project']},relations:[{as:'work',direction:'incoming',field:'project',filter:{types:['task'],fields:{status:{one_of:['done','open','in-progress']}}},metrics:[{as:'completion',op:'percentage',matching_filter:{fields:{status:{eq:'done'}}}}],lookup:{limit:1}}],sort:{by:'metric',relation:'work',metric:'completion',order:'desc'}});
const run=(r=req()):SummaryData=>JSON.parse(summarizeNodes(db,r).content[0].text).data;
it('excludes outsider IDs from pure subset arithmetic',()=>{
 expect(percentageOf(new Set(['a','b','c','d']),new Set(['a','b','outsider']))).toEqual({value:50,details:{numerator_count:2,denominator_count:4}});
 expect(percentageOf(new Set(),new Set(['outsider']))).toEqual({value:null,details:{numerator_count:0,denominator_count:0}});
});
it('computes full-population percentages and components before paging and lookup caps',()=>{
 seedRel(db,'T1','alias','P1'); const r=req();r.limit=1;
 const result=run(r); expect(result.rows[0].node.id).toBe('P1');
 expect(result.rows[0].relations.work.metrics.completion).toBeCloseTo(100/3,12);
 expect(result.rows[0].relations.work.metric_details?.completion).toEqual({numerator_count:1,denominator_count:3});
 expect(result.rows[0].relations.work.lookup?.returned).toBe(1);
 expect(result.page.total).toBe(3);
});
it('distinguishes zero completion from no eligible members and keeps null last',()=>{
 const r=req();r.sort={by:'metric',relation:'work',metric:'completion',order:'asc'};
 expect(run(r).rows.map(x=>[x.node.id,x.relations.work.metrics.completion])).toEqual([['P2',0],['P1',100/3],['P3',null]]);
 expect(run(r).rows[2].relations.work.metric_details?.completion).toEqual({numerator_count:0,denominator_count:0});
});
it('intersects broad numerators with each parent denominator and supports multiple metrics',()=>{
 const r=req();r.relations[0].filter={fields:{status:{eq:'open'}}};
 r.relations[0].metrics=[{as:'completion',op:'percentage',matching_filter:{}},{as:'done',op:'percentage',matching_filter:{fields:{status:{eq:'done'}}}},{as:'n',op:'count'}];
 const rows=run(r).rows;
 expect(rows[0].relations.work.metrics).toEqual({completion:100,done:0,n:1});
 expect(rows[1].relations.work.metrics).toEqual({completion:100,done:0,n:2});
});
it('remains read-only and omits new metadata on legacy reads',()=>{
 const before=db.serialize();run();expect(db.serialize()).toEqual(before);
 const r=req();r.relations[0].metrics=[{as:'completion',op:'count'}];
 expect(run(r).rows[0].relations.work).not.toHaveProperty('metric_details');
 expect(run(r)).not.toHaveProperty('evaluation_context');
});
it('honors explicit-null markers over legacy rows in numerator, denominator and parent filters',()=>{
 db.prepare('INSERT INTO node_explicit_null_fields (node_id,field_name) VALUES (?,?)').run('T3','status');
 const r=req();r.relations[0].filter={types:['task']};
 const result=run(r).rows.find(row=>row.node.id==='P1')!.relations.work;
 expect(result.metrics.completion).toBe(0);
 expect(result.metric_details?.completion).toEqual({numerator_count:0,denominator_count:3});
 r.relations[0].metrics=[{as:'completion',op:'percentage',matching_filter:{fields:{status:{ne:'open'}}}}];
 expect(run(r).rows.find(row=>row.node.id==='P1')!.relations.work.metric_details?.completion).toEqual({numerator_count:1,denominator_count:3});
 r.relations[0].filter={fields:{status:{one_of:['done','open','in-progress']}}};
 expect(run(r).rows.find(row=>row.node.id==='P1')!.relations.work.metric_details?.completion).toEqual({numerator_count:1,denominator_count:2});
 db.prepare('INSERT INTO node_explicit_null_fields (node_id,field_name) VALUES (?,?)').run('P1','status');
 r.filter={types:['project'],fields:{status:{eq:'open'}}};
 expect(run(r).rows.map(row=>row.node.id)).toEqual(['P3']);
});
it('includes percentage component metadata in the response byte budget',()=>{
 const r=req();r.filter={node_ids:['P1']};delete r.relations[0].lookup;
 db.prepare("UPDATE nodes SET title='' WHERE id='P1'").run();
 const initial=Buffer.byteLength(summarizeNodes(db,r).content[0].text,'utf8');
 db.prepare("UPDATE nodes SET title=? WHERE id='P1'").run('x'.repeat(1048576-initial));
 expect(Buffer.byteLength(summarizeNodes(db,r).content[0].text,'utf8')).toBe(1048576);
 db.prepare("UPDATE nodes SET title=title || 'x' WHERE id='P1'").run();
 expect(()=>run(r)).toThrow(expect.objectContaining({details:expect.objectContaining({stage:'response_bytes',limit:1048576})}));
});
