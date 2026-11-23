import { afterEach,beforeEach,expect,it } from 'vitest';
import type Database from 'better-sqlite3';
import { makeRollupDb,projectViews } from '../helpers/rollup-fixture.js';
import { readRollups } from '../../src/rollups/service.js';
import { describeRelationshipViews } from '../../src/rollups/definitions.js';
let db:Database.Database;
const context={time_zone:'America/New_York',as_of:'2026-09-19T16:00:00Z'};
beforeEach(()=>{db=makeRollupDb();const views=projectViews();db.prepare("UPDATE schemas SET metadata=? WHERE name='project'").run(JSON.stringify({relationship_views_v1:{...views,rollups:[...views.rollups,
{name:'completion',relation:'tasks',metric:{op:'percentage',matching_filter:{fields:{status:{eq:'done'}}}}},
{name:'overdue',relation:'tasks',filter:{fields:{status:{one_of:['open','in-progress']},due:{date_window:{to_days:0}}}},metric:{op:'count'}},
{name:'past_share',relation:'tasks',metric:{op:'percentage',matching_filter:{fields:{due:{date_window:{to_days:0}}}}}}
]}}));});afterEach(()=>db.close());
it('discovers percent and clock-dependent definitions without requiring a clock',()=>{
 const d=describeRelationshipViews(db,'project');expect(d.state).toBe('valid');
 expect(d.rollups.find(x=>x.definition.name==='completion')).toMatchObject({state:'valid',type:'number',nullable:true,unit:'percent'});
 for(const name of ['overdue','past_share']) expect(d.rollups.find(x=>x.definition.name===name)).toHaveProperty('requires_evaluation_context',true);
});
it('returns saved percentage components and shared effective context with exact sort',()=>{
 const r=JSON.parse(readRollups(db,{schema:'project',rollups:['completion','overdue'],evaluation_context:context,sort:{by:'rollup',name:'completion',order:'desc'},limit:1}).content[0].text);
 expect(r.data.rows[0]).toMatchObject({node:{id:'P1'},rollups:{completion:100/3,overdue:1},rollup_details:{completion:{numerator_count:1,denominator_count:3}}});
 expect(r.data.evaluation_context.calendar_date).toBe('2026-09-19');
});
it('requires context only for selected temporal definitions',()=>{
 expect(()=>readRollups(db,{schema:'project',rollups:['completion']})).not.toThrow();
 for(const name of ['overdue','past_share']) expect(()=>readRollups(db,{schema:'project',rollups:[name]})).toThrow(/time_zone/);
});
it('keeps legacy responses unchanged even with other temporal definitions',()=>{
 const r=JSON.parse(readRollups(db,{schema:'project',rollups:['open_task_count']}).content[0].text);
 expect(r.data).not.toHaveProperty('evaluation_context');expect(r.data.rows[0]).not.toHaveProperty('rollup_details');
});
