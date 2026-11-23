import {expect,it} from 'vitest';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {classificationDb} from '../helpers/classification-fixture.js';
import {registerUpdateGlobalField} from '../../src/mcp/tools/update-global-field.js';
import {getGlobalField} from '../../src/global-fields/crud.js';
import {globalClassificationHash} from '../../src/classification/definitions.js';
it('previews and applies guarded metadata without node changes or rejected undo entries',async()=>{
 const db=classificationDb();let handler:any;
 registerUpdateGlobalField({tool:(_n:unknown,_d:unknown,_s:unknown,h:unknown)=>handler=h} as unknown as McpServer,db);
 const call=async(input:unknown)=>JSON.parse((await handler(input)).content[0].text);
 const nodes=db.prepare('SELECT * FROM nodes').all();const operations=()=>db.prepare('SELECT COUNT(*) AS n FROM undo_operations').get();const before=operations();
 const input={name:'status',enum_groups:{version:1,groups:[]},expected_enum_groups_hash:globalClassificationHash(getGlobalField(db,'status')!)};
 expect((await call({...input,dry_run:true})).data.classification.changed_node_context_pairs).toBe(5);
 expect(operations()).toEqual(before);
 expect((await call({...input,dry_run:true,description:'unsupported'})).error.code).toBe('INVALID_PARAMS');
 expect((await call({...input,expected_enum_groups_hash:'stale'})).error.code).toBe('CLASSIFICATION_STALE_DEFINITION');
 expect(operations()).toEqual(before);
 expect((await call(input)).ok).toBe(true);
 expect(db.prepare('SELECT * FROM nodes').all()).toEqual(nodes);
 expect((await call(input)).error.code).toBe('CLASSIFICATION_STALE_DEFINITION');db.close();
});

it('guards schema overrides against both their own definition and global changes',async()=>{
 const {createTempVault}=await import('../helpers/vault.js');const {WriteLockManager}=await import('../../src/sync/write-lock.js');
 const {registerUpdateSchema}=await import('../../src/mcp/tools/update-schema.js');const {registerDescribeSchema}=await import('../../src/mcp/tools/describe-schema.js');
 const db=classificationDb();const {vaultPath,cleanup}=createTempVault();const handlers=new Map<string,any>();
 const server={tool:(n:string,_d:unknown,_s:unknown,h:unknown)=>handlers.set(n,h),registerTool:(n:string,_c:unknown,h:unknown)=>handlers.set(n,h)} as unknown as McpServer;
 registerUpdateSchema(server,db,{vaultPath,writeLock:new WriteLockManager()});registerDescribeSchema(server,db);
 const call=async(n:string,input:unknown)=>JSON.parse((await handlers.get(n)(input)).content[0].text);
 const info=(await call('describe-schema',{name:'task',include:['classification']})).data.classification.fields.status;
 const claim={field:'status',enum_groups_override:{version:1,groups:[]},expected_enum_groups_hash:info.definition_hash,expected_global_enum_groups_hash:info.global_definition_hash};
 const versions=db.prepare('SELECT id,version FROM nodes').all();
 const preview=await call('update-schema',{name:'task',update_field_claims:[claim],dry_run:true});
 expect(preview.ok).toBe(true);expect(preview.data.classification[0].changed_node_context_pairs).toBe(5);
 expect((await call('update-schema',{name:'task',update_field_claims:[{...claim,expected_global_enum_groups_hash:'stale'}]})).error.code).toBe('CLASSIFICATION_STALE_DEFINITION');
 expect((await call('update-schema',{name:'task',update_field_claims:[claim]})).ok).toBe(true);
 expect(db.prepare('SELECT id,version FROM nodes').all()).toEqual(versions);
 expect((await call('update-schema',{name:'task',update_field_claims:[claim]})).error.code).toBe('CLASSIFICATION_STALE_DEFINITION');db.close();cleanup();
});

it('guards inherited claim additions and previews the absent context as unconfigured',async()=>{
 const {createTempVault}=await import('../helpers/vault.js');const {WriteLockManager}=await import('../../src/sync/write-lock.js');
 const {registerUpdateSchema}=await import('../../src/mcp/tools/update-schema.js');
 const db=classificationDb();const {vaultPath,cleanup}=createTempVault();let handler:any;
 db.exec("INSERT INTO schemas(name,field_claims) VALUES('newtype','[]'); INSERT INTO node_types(node_id,schema_type) VALUES('A','newtype');");
 registerUpdateSchema({registerTool:(_n:unknown,_c:unknown,h:unknown)=>handler=h} as unknown as McpServer,db,{vaultPath,writeLock:new WriteLockManager()});
 const call=async(claim:unknown,dry_run=true)=>JSON.parse((await handler({name:'newtype',add_field_claims:[claim],dry_run})).content[0].text);
 const before=db.prepare('SELECT * FROM undo_operations').all();
 for(const expected_global_enum_groups_hash of [undefined,'stale']) expect((await call({field:'status',expected_global_enum_groups_hash},false)).error?.code).toBe('CLASSIFICATION_STALE_DEFINITION');
 expect(db.prepare('SELECT * FROM undo_operations').all()).toEqual(before);
 const {previewSchemaClassification}=await import('../../src/classification/preview.js');
 const claim={field:'status',expected_global_enum_groups_hash:globalClassificationHash(getGlobalField(db,'status')!)};
 const preview=previewSchemaClassification(db,'newtype',{add_field_claims:[claim]});
 expect(preview[0]).toMatchObject({changed_node_context_pairs:1,counts:[{before:{not_configured:1},after:{'group:active':1}}]});
 db.exec("DELETE FROM node_types WHERE schema_type='newtype'");
 expect((await call(claim,false)).ok).toBe(true);
 db.close();cleanup();
});
