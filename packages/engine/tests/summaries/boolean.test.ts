import { afterEach, beforeEach, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { makeSummaryDb, seedRel } from '../helpers/summary-fixture.js';
import { summarizeNodes } from '../../src/summaries/service.js';
import type { SummaryData, SummaryRequest, SummaryFilterLeaf } from '../../src/summaries/types.js';
let db:Database.Database;
beforeEach(()=>{db=makeSummaryDb();});afterEach(()=>db.close());
const req=():SummaryRequest=>({filter:{node_ids:['P1','P3']},relations:[{as:'work',direction:'incoming',field:'project',filter:{types:['task'],where:{any:[{fields:{status:{eq:'open'}}},{fields:{status:{eq:'done'}}}]}},metrics:[{as:'n',op:'count'},{as:'completion',op:'percentage',matching_filter:{where:{any:[{fields:{status:{eq:'done'}}},{fields:{estimate:{lt:0}}}]}}}],lookup:{limit:1}}]});
const run=(r=req()):SummaryData=>JSON.parse(summarizeNodes(db,r).content[0].text).data;
it('computes exact distinct denominator and subset numerator before lookup and paging',()=>{
  seedRel(db,'T1','alias','P1');const before=db.serialize();
  const rows=run().rows;
  expect(rows[0].relations.work.metrics).toEqual({n:2,completion:50});
  expect(rows[0].relations.work.metric_details?.completion).toEqual({numerator_count:1,denominator_count:2});
  expect(rows[0].relations.work.lookup).toMatchObject({total:2,returned:1});
  expect(rows[1].relations.work.metric_details?.completion).toEqual({numerator_count:0,denominator_count:0});
  expect(rows[1].relations.work.metrics.completion).toBeNull();
  expect(db.serialize()).toEqual(before);
});
it('preserves outer parent constraints and unions overlapping branches once',()=>{
  const r=req();r.filter={types:['project'],where:{any:[{node_ids:['P1','T1']},{title_eq:'P1'}]}};
  r.relations[0].filter={where:{any:[{fields:{status:{eq:'open'}}},{fields:{status:{one_of:['open','done']}}}]}};
  expect(run(r).rows.map(x=>[x.node.id,x.relations.work.metrics.n])).toEqual([['P1',2]]);
});
it('keeps explicit null precedence for comparisons but row presence for exists',()=>{
  db.prepare('INSERT INTO node_explicit_null_fields (node_id,field_name) VALUES (?,?)').run('T3','status');
  expect(run().rows[0].relations.work.metrics).toEqual({n:1,completion:0});
  const r=req();r.relations[0].filter={where:{all:[{fields:{status:{exists:true}}},{node_ids:['T3']}]}};
  expect(run(r).rows[0].relations.work.metrics.n).toBe(1);
});
it.each<SummaryFilterLeaf>([{fields:{missing:{eq:'x'}}},{fields:{due:{gt:1}}},{types:['nonexistent']}])('validates nested leaves %j',leaf=>{
  const r=req();r.filter={where:{any:[{node_ids:['P1']},leaf]}};
  expect(()=>run(r)).toThrow();
});
