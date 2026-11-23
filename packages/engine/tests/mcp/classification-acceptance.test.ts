import {expect,it} from 'vitest';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createTestDb} from '../helpers/db.js';
import {createTempVault} from '../helpers/vault.js';
import {WriteLockManager} from '../../src/sync/write-lock.js';
import {registerCreateGlobalField} from '../../src/mcp/tools/create-global-field.js';
import {registerUpdateGlobalField} from '../../src/mcp/tools/update-global-field.js';
import {registerCreateSchema} from '../../src/mcp/tools/create-schema.js';
import {registerDescribeGlobalField} from '../../src/mcp/tools/describe-global-field.js';
import {registerClassifyNodes} from '../../src/mcp/tools/classify-nodes.js';
import {registerUndoOperations} from '../../src/mcp/tools/undo-operations.js';
import {executeMutation} from '../../src/pipeline/execute.js';
it('creates, discovers, previews, applies and undoes classification metadata through MCP',async()=>{
 const db=createTestDb(),{vaultPath,cleanup}=createTempVault(),writeLock=new WriteLockManager();const ctx={vaultPath,writeLock};const handlers=new Map<string,any>();
 const server={tool:(n:string,_d:unknown,_s:unknown,h:unknown)=>handlers.set(n,h),registerTool:(n:string,_c:unknown,h:unknown)=>handlers.set(n,h)} as unknown as McpServer;
 registerCreateGlobalField(server,db,ctx);registerUpdateGlobalField(server,db,ctx);registerCreateSchema(server,db,ctx);registerDescribeGlobalField(server,db);registerClassifyNodes(server,db);registerUndoOperations(server,db,writeLock,vaultPath);
 const call=async(n:string,args:unknown)=>JSON.parse((await handlers.get(n)(args)).content[0].text);
 try {
  const initial={version:1,groups:[{name:'active',values:['ready']},{name:'waiting',values:[]}]};
  expect((await call('create-global-field',{name:'status',field_type:'enum',enum_values:['ready'],enum_groups:initial})).ok).toBe(true);
  const field=(await call('describe-global-field',{name:'status'})).data;
  expect((await call('create-schema',{name:'task',field_claims:[{field:'status',expected_global_enum_groups_hash:field.enum_groups_hash}]})).ok).toBe(true);
  const node=executeMutation(db,writeLock,vaultPath,{source:'tool',node_id:null,file_path:'A.md',title:'A',types:['task'],fields:{status:'ready'},body:'Keep me'});
  const id=node.node_id;const inspect=()=>call('classify-nodes',{schema:'task',field:'status',node_ids:[id]});
  const before=await inspect();const version=db.prepare('SELECT version FROM nodes WHERE id=?').get(id);const bytes=readFileSync(join(vaultPath,'A.md'),'utf8');
  const change={name:'status',enum_groups:{version:1,groups:[{name:'active',values:[]},{name:'waiting',values:['ready']}]},expected_enum_groups_hash:field.enum_groups_hash};
  expect((await call('update-global-field',{...change,dry_run:true})).data.classification.changed_node_context_pairs).toBe(1);
  expect((await inspect()).data.execution_hash).toBe(before.data.execution_hash);
  const applied=await call('update-global-field',change);expect(applied.ok).toBe(true);
  const after=await inspect();expect(after.data.results[0].groups).toEqual(['waiting']);expect(after.data.execution_hash).not.toBe(before.data.execution_hash);
  expect(db.prepare('SELECT version FROM nodes WHERE id=?').get(id)).toEqual(version);expect(readFileSync(join(vaultPath,'A.md'),'utf8')).toBe(bytes);
  expect(readFileSync(join(vaultPath,'.schemas/_fields.yaml'),'utf8')).toContain('waiting');
  const undone=await call('undo-operations',{operation_ids:[applied.data.operation_id],dry_run:false});expect(undone.ok).toBe(true);
  expect((await inspect()).data.execution_hash).toBe(before.data.execution_hash);
  expect(db.prepare('SELECT version FROM nodes WHERE id=?').get(id)).toEqual(version);
 } finally {db.close();cleanup();}
});
