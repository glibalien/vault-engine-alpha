import {createOperation} from '../../src/undo/operation.js';
import {createTestDb} from '../helpers/db.js';
import {seedSummaryFixture} from '../helpers/summary-fixture.js';
import {afterEach,beforeEach,expect,it} from 'vitest';
import type Database from 'better-sqlite3';
import {seedRollups,projectViews} from '../helpers/rollup-fixture.js';
import {parseRelationshipViews,describeRelationshipViews,relationshipViewsHash} from '../../src/rollups/definitions.js';
import {readRollups} from '../../src/rollups/service.js';
import {renameRelationshipViewFields} from '../../src/rollups/mutation.js';
import type {RelationshipViews} from '../../src/rollups/types.js';
let db:Database.Database;
beforeEach(()=>{db=createTestDb();seedSummaryFixture(db);seedRollups(db);});afterEach(()=>db.close());
const views=():RelationshipViews=>({version:1,relations:[{name:'tasks',direction:'incoming',field:'project',filter:{types:['task']}}],rollups:[{name:'completion',relation:'tasks',filter:{where:{any:[{fields:{status:{eq:'open'}}},{fields:{status:{eq:'done'}}}]}},metric:{op:'percentage',matching_filter:{where:{any:[{fields:{status:{eq:'done'}}},{fields:{estimate:{lt:0}}}]}}}}]});
function install(v:unknown){db.prepare("UPDATE schemas SET metadata=? WHERE name='project'").run(JSON.stringify({other:'preserved',relationship_views_v1:v}));}
const run=(input:unknown)=>JSON.parse(readRollups(db,input).content[0].text).data;
it('preserves legacy hash and adds expression identity without reordering arrays',()=>{
  expect(relationshipViewsHash(projectViews())).toBe('ff0c6cc5f89b0374f3a9fce3ba4228a0d260a1f8d238bea8c46886a914bfa9cc');
  const v=views();expect(parseRelationshipViews(v)).toEqual(v);
  const reversed=structuredClone(v);const e=reversed.rollups[0].filter!.where!;if('any'in e)e.any.reverse();
  expect(relationshipViewsHash(v)).not.toBe(relationshipViewsHash(reversed));
});
it('discovers and reads saved subsets with owner constraints intact',()=>{
  install(views());expect(describeRelationshipViews(db,'project').rollups[0].state).toBe('valid');
  const r=run({schema:'project',rollups:['completion'],filter:{where:{any:[{node_ids:['P1']},{types:['task']}]}}});
  expect(r.rows.map((x:any)=>x.node.id)).toEqual(['P1']);expect(r.rows[0].rollups.completion).toBe(50);
  expect(r.rows[0].rollup_details.completion).toEqual({numerator_count:1,denominator_count:2});
});
it('detects dependencies and dates inside leaves without requiring unselected temporal definitions',()=>{
  const v=views();v.rollups.push({name:'due',relation:'tasks',filter:{where:{fields:{due:{date_window:{to_days:0}}}}},metric:{op:'count'}});
  install(v);const d=describeRelationshipViews(db,'project');expect(d.rollups[1].requires_evaluation_context).toBe(true);
  expect(()=>run({schema:'project',rollups:['completion']})).not.toThrow();
  db.prepare("DELETE FROM global_fields WHERE name='due'").run();
  expect(describeRelationshipViews(db,'project').rollups.map(r=>r.state)).toEqual(['valid','invalid']);
});
it('counts combined selections before descriptor packing',()=>{
  const v=views();v.rollups=[];
  const where={any:Array.from({length:7},()=>({fields:{status:{eq:'open'}}}))};
  for(let n=0;n<8;n++)v.rollups.push({name:`r${n}`,relation:'tasks',filter:{where},metric:{op:'count'}});
  install(v);expect(describeRelationshipViews(db,'project').state).toBe('valid');
  expect(()=>run({schema:'project',rollups:['r0']})).not.toThrow();
  // 8*8 selected expression nodes + one user parent leaf exceeds 64 even though packing shares filters.
  expect(()=>run({schema:'project',rollups:v.rollups.map(r=>r.name),filter:{where:{title_eq:'P1'}}})).toThrow(expect.objectContaining({details:expect.objectContaining({reason:'nodes',limit:64})}));
});
it('renames nested keys in eligibility and numerator without rewriting literals',()=>{
  const v=views();v.rollups[0].filter={where:{any:[{fields:{status:{eq:'status'}}},{fields:{estimate:{gt:0}}}]}};install(v);
  expect(renameRelationshipViewFields(db,'status','state',createOperation(db,{source_tool:'rename-global-field',description:'Boolean rename'}))).toEqual(['project']);
  const metadata=JSON.parse((db.prepare("SELECT metadata FROM schemas WHERE name='project'").get() as any).metadata);
  expect(metadata.other).toBe('preserved');
  expect(JSON.stringify(metadata.relationship_views_v1)).toContain('"state":{"eq":"status"}');
  expect(JSON.stringify(metadata.relationship_views_v1)).toContain('"state":{"eq":"done"}');
});
it('rejects broadened saved relation and fields-only leaf vocabularies',()=>{
  const v:any=views();v.rollups[0].filter={where:{types:['task']}};expect(()=>parseRelationshipViews(v)).toThrow();
  v.rollups=[];v.relations[0].filter={where:{types:['task']}};expect(()=>parseRelationshipViews(v)).toThrow();
});
