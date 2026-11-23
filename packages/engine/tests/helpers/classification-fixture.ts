import type Database from 'better-sqlite3';
import { createTestDb } from './db.js';
import { seedNode, seedRel } from './summary-fixture.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
export const enumGroups = {version:1 as const,groups:[
 {name:'active',values:['ready','waiting']},{name:'waiting',values:['waiting']},
 {name:'completed',values:['finished']},{name:'closed',values:['finished','cancelled']},
 {name:'ignored',values:['cancelled']},{name:'backlog',values:['planned']},
]};
export function classificationDb(): Database.Database {
 const db=createTestDb();
 createGlobalField(db,{name:'status',field_type:'enum',enum_values:['ready','waiting','finished','cancelled','someday','planned'],enum_groups:enumGroups,overrides_allowed:{enum_groups:true,enum_values:true}});
 createGlobalField(db,{name:'project',field_type:'reference',reference_target:'project'});
 createSchemaDefinition(db,{name:'task',field_claims:[{field:'status'},{field:'project'}]});
 createSchemaDefinition(db,{name:'project',field_claims:[{field:'status',enum_groups_override:{version:1,groups:[{name:'active',values:['finished']}]}}]});
 seedNode(db,'P',['project'],{status:'ready'});
 for(const [id,value] of [['A','ready'],['B','waiting'],['C','finished'],['D','cancelled'],['E',undefined],['F',null],['G','someday'],['H','planned']] as const) {
  seedNode(db,id,['task'],value===undefined ? {} : {status:value});seedRel(db,id,'P','P');
 }
 return db;
}
