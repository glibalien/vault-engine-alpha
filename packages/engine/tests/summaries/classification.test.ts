import {expect,it} from 'vitest';
import {classificationDb} from '../helpers/classification-fixture.js';
import {summarizeNodes} from '../../src/summaries/service.js';
export const group=(group:string)=>({fields:{status:{in_group:{schema:'task',group}}}});
it('uses the same group sets for summary counts, lookups and percentage denominators',()=>{
 const db=classificationDb();
 const result=JSON.parse(summarizeNodes(db,{filter:{node_ids:['P']},relations:[
 {as:'active',direction:'incoming',field:'project',filter:group('active'),metrics:[{as:'count',op:'count'}],lookup:{fields:['status'],limit:1}},
 {as:'unknown',direction:'incoming',field:'project',filter:{fields:{status:{is_unclassified:{schema:'task'}}}},metrics:[{as:'count',op:'count'}]},
 {as:'completion',direction:'incoming',field:'project',filter:{where:{any:[group('active'),group('completed')]}},metrics:[{as:'percent',op:'percentage',matching_filter:group('completed')}]}
 ]}).content[0].text).data;
 expect(result.rows[0].relations.active.metrics.count).toBe(2);
 expect(result.rows[0].relations.unknown.metrics.count).toBe(3);
 expect(result.rows[0].relations.completion.metric_details.percent).toEqual({numerator_count:1,denominator_count:3});
 expect(result.classification_dependencies).toHaveLength(1);
 expect(()=>summarizeNodes(db,{filter:{node_ids:['absent']},relations:[{as:'x',direction:'incoming',field:'project',filter:group('typo'),metrics:[{as:'count',op:'count'}]}]})).toThrow();db.close();
});
