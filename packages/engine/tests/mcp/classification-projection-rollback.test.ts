import {expect,it} from 'vitest';
import {appendFileSync,mkdirSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {classificationDb} from '../helpers/classification-fixture.js';
import {createTempVault} from '../helpers/vault.js';
import {WriteLockManager} from '../../src/sync/write-lock.js';
import {renderFieldsFile,renderSchemaFile} from '../../src/schema/render.js';
import {globalClassificationHash} from '../../src/classification/definitions.js';
import {getGlobalField} from '../../src/global-fields/crud.js';
import {inputDefinitionHash} from '../../src/classification/preview.js';
import {loadClassificationInput} from '../../src/classification/read.js';
import {registerUpdateGlobalField} from '../../src/mcp/tools/update-global-field.js';
import {registerCreateGlobalField} from '../../src/mcp/tools/create-global-field.js';
import {registerCreateSchema} from '../../src/mcp/tools/create-schema.js';
import {registerUpdateSchema} from '../../src/mcp/tools/update-schema.js';
import {registerRenameGlobalField} from '../../src/mcp/tools/rename-global-field.js';

it.each(['update-global-field','create-global-field','create-schema','update-schema','rename-global-field'])('%s rolls back classification, undo and earlier owned projections on projection failure',async mode=>{
 const db=classificationDb();const {vaultPath,cleanup}=createTempVault();const handlers=new Map<string,any>();
 const server={tool:(name:string,_d:unknown,_s:unknown,h:unknown)=>handlers.set(name,h),registerTool:(name:string,_c:unknown,h:unknown)=>handlers.set(name,h)} as unknown as McpServer;
 const ctx={vaultPath,writeLock:new WriteLockManager()};
 registerUpdateGlobalField(server,db,ctx);registerCreateGlobalField(server,db,ctx);registerCreateSchema(server,db,ctx);registerUpdateSchema(server,db,ctx);registerRenameGlobalField(server,db,{vaultPath});
 renderFieldsFile(db,vaultPath);renderSchemaFile(db,vaultPath,'project');renderSchemaFile(db,vaultPath,'task');
 const globalHash=globalClassificationHash(getGlobalField(db,'status')!);
 const claim={field:'status',enum_groups_override:{version:1,groups:[]},expected_enum_groups_hash:inputDefinitionHash(loadClassificationInput(db,{schema:'task',field:'status'})),expected_global_enum_groups_hash:globalHash};
 const inputs:Record<string,unknown>={
  'update-global-field':{name:'status',enum_groups:{version:1,groups:[]},expected_enum_groups_hash:globalHash},
  'create-global-field':{name:'newstatus',field_type:'enum',enum_values:['open'],enum_groups:{version:1,groups:[]}},
  'create-schema':{name:'newtype',field_claims:[{field:'status',expected_global_enum_groups_hash:globalHash}]},
  'update-schema':{name:'task',update_field_claims:[claim]},
  'rename-global-field':{old_name:'status',new_name:'stage'},
 };
 const snapshot=()=>Object.fromEntries(['global_fields','schemas','schema_field_claims','schema_file_hashes','nodes','node_fields','undo_operations','undo_global_field_snapshots','undo_schema_snapshots'].map(table=>[table,db.prepare(`SELECT * FROM ${table}`).all()]));
 const before=snapshot();const fields=readFileSync(join(vaultPath,'.schemas/_fields.yaml'),'utf8');const project=readFileSync(join(vaultPath,'.schemas/project.yaml'),'utf8');
 const target=join(vaultPath,'.schemas',mode==='create-global-field'?'_fields.yaml':mode==='create-schema'?'newtype.yaml':'task.yaml');
 rmSync(target,{force:true});mkdirSync(target);
 const response=JSON.parse((await handlers.get(mode)(inputs[mode])).content[0].text);
 expect(response.ok).toBe(false);expect(snapshot()).toEqual(before);
 if(mode!=='create-global-field') expect(readFileSync(join(vaultPath,'.schemas/_fields.yaml'),'utf8')).toBe(fields);
 expect(readFileSync(join(vaultPath,'.schemas/project.yaml'),'utf8')).toBe(project);
 db.close();cleanup();
});

it('warns when a classification-only update-schema edit cannot render its externally edited YAML',async()=>{
 const db=classificationDb();const {vaultPath,cleanup}=createTempVault();const handlers=new Map<string,any>();
 const server={tool:(name:string,_d:unknown,_s:unknown,h:unknown)=>handlers.set(name,h),registerTool:(name:string,_c:unknown,h:unknown)=>handlers.set(name,h)} as unknown as McpServer;
 registerUpdateSchema(server,db,{vaultPath,writeLock:new WriteLockManager()});
 renderSchemaFile(db,vaultPath,'task');
 const path=join(vaultPath,'.schemas/task.yaml');appendFileSync(path,'# kept by hand\n');const bytes=readFileSync(path,'utf8');
 const claim={field:'status',enum_groups_override:{version:1,groups:[]},expected_enum_groups_hash:inputDefinitionHash(loadClassificationInput(db,{schema:'task',field:'status'})),
  expected_global_enum_groups_hash:globalClassificationHash(getGlobalField(db,'status')!)};
 const versions=db.prepare('SELECT id,version FROM nodes ORDER BY id').all();
 const response=JSON.parse((await handlers.get('update-schema')({name:'task',update_field_claims:[claim]})).content[0].text);
 expect(response).toMatchObject({ok:true,data:{operation_id:expect.any(String)},warnings:[expect.objectContaining({code:'SCHEMA_FILE_RENDER_BLOCKED',details:{schema:'task'}})]});
 expect(readFileSync(path,'utf8')).toBe(bytes);
 const row=db.prepare("SELECT enum_groups_override FROM schema_field_claims WHERE schema_name='task' AND field='status'").get() as {enum_groups_override:string|null};
 expect(JSON.parse(row.enum_groups_override!)).toEqual({version:1,groups:[]});
 expect(db.prepare('SELECT id,version FROM nodes ORDER BY id').all()).toEqual(versions);
 expect(db.prepare("SELECT COUNT(*) AS n FROM edits_log WHERE event_type='schema-file-render-blocked'").get()).toEqual({n:1});
 db.close();cleanup();
});
