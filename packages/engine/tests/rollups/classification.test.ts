import {expect,it} from 'vitest';
import {classificationDb} from '../helpers/classification-fixture.js';
import {readRollups} from '../../src/rollups/service.js';
import {renameRelationshipViewFields} from '../../src/rollups/mutation.js';
import {renameGlobalField} from '../../src/global-fields/crud.js';
import {createOperation} from '../../src/undo/operation.js';
it('keeps saved hashes separate from resolved dependencies and renames nested filters',()=>{
 const db=classificationDb();const group=(group:string)=>({fields:{status:{in_group:{schema:'task',group}}}});
 db.prepare("UPDATE schemas SET metadata=? WHERE name='project'").run(JSON.stringify({relationship_views_v1:{version:1,relations:[{name:'tasks',direction:'incoming',field:'project',filter:{types:['task']}}],rollups:[{name:'completion',relation:'tasks',filter:{where:{any:[group('active'),group('completed')]}},metric:{op:'percentage',matching_filter:group('completed')}},{name:'closed',relation:'tasks',filter:group('closed'),metric:{op:'count'}}]}}));
 const result=JSON.parse(readRollups(db,{schema:'project',rollups:['completion','closed']}).content[0].text).data;
 expect(result.rows[0].rollup_details.completion).toEqual({numerator_count:1,denominator_count:3});expect(result.rows[0].rollups.closed).toBe(2);
 expect(result.classification_dependencies).toHaveLength(1);
 const op=createOperation(db,{source_tool:'test',description:'rename'});renameGlobalField(db,'status','phase');renameRelationshipViewFields(db,'status','phase',op);
 const renamed=JSON.parse(readRollups(db,{schema:'project',rollups:['completion']}).content[0].text).data;
 expect(renamed.rows[0].rollup_details.completion).toEqual({numerator_count:1,denominator_count:3});expect(renamed.classification_dependencies[0].field).toBe('phase');db.close();
});
