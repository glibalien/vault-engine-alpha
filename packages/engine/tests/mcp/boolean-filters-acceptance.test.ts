import {registerQueryNodes} from '../../src/mcp/tools/query-nodes.js';
import type {RelationshipViews} from '../../src/rollups/types.js';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { seedSummaryFixture, seedNode, seedRel } from '../helpers/summary-fixture.js';
import { projectViews } from '../helpers/rollup-fixture.js';
import { registerCreateSchema } from '../../src/mcp/tools/create-schema.js';
import { registerUpdateSchema } from '../../src/mcp/tools/update-schema.js';
import { registerRenameGlobalField } from '../../src/mcp/tools/rename-global-field.js';
import { registerUndoOperations } from '../../src/mcp/tools/undo-operations.js';
import { registerSummarizeNodes } from '../../src/mcp/tools/summarize-nodes.js';
import { registerReadRollups } from '../../src/mcp/tools/read-rollups.js';
import { registerDescribeSchema } from '../../src/mcp/tools/describe-schema.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { relationshipViewsHash } from '../../src/rollups/definitions.js';
import { restoreSchemaSnapshot } from '../../src/undo/schema-snapshot.js';
let db: Database.Database,
  server: McpServer,
  client: Client,
  vaultPath: string,
  cleanup: () => void;
beforeEach(async () => {
  db = createTestDb();
  seedSummaryFixture(db);
  ({ vaultPath, cleanup } = createTempVault());
  server = new McpServer({ name: 'rollup-schema-test', version: '1' });
  registerCreateSchema(server, db, { vaultPath });
  registerUpdateSchema(server, db, {
    vaultPath,
    writeLock: new WriteLockManager(),
  });
  registerDescribeSchema(server, db);
  registerReadRollups(server, db);
  registerSummarizeNodes(server, db);
  registerQueryNodes(server,db);
  registerRenameGlobalField(server, db, { vaultPath });
  registerUndoOperations(server, db, new WriteLockManager(), vaultPath);
  client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
});
afterEach(async () => {
  await client.close();
  await server.close();
  db.close();
  cleanup();
});
async function call(name: string, args: Record<string, unknown>) {
  const r = await client.callTool({ name, arguments: args });
  const text=(r.content as Array<{text:string}>)[0].text;
  try{return JSON.parse(text);}catch{return {transportError:r.isError,message:text};}
}

const definitions=():RelationshipViews=>({version:1,relations:[{name:'tasks',direction:'incoming',field:'project',filter:{types:['task']}}],rollups:[{name:'completion',relation:'tasks',filter:{where:{any:[{fields:{status:{eq:'open'}}},{fields:{status:{eq:'done'}}}]}},metric:{op:'percentage',matching_filter:{where:{any:[{fields:{status:{eq:'done'}}},{fields:{estimate:{lt:0}}}]}}}}]});
it('previews, installs, exports, reads, renames and undoes expressions via governed MCP',async()=>{
  const views=definitions(),hash=relationshipViewsHash(views);
  const args={name:'project',relationship_views:views,expected_relationship_views_hash:relationshipViewsHash(undefined)};
  const before=db.serialize();
  expect((await call('update-schema',{...args,dry_run:true})).ok).toBe(true);expect(db.serialize()).toEqual(before);
  const applied=await call('update-schema',args);expect(applied.ok).toBe(true);
  const discovery=await call('describe-schema',{name:'project',include:['relationship_views']});
  expect(discovery.data.relationship_views_hash).toBe(hash);expect(discovery.data.relationship_views.state).toBe('valid');
  expect(parse(readFileSync(join(vaultPath,'.schemas/project.yaml'),'utf8')).relationship_views).toEqual(views);
  expect(await call('update-schema',args)).toMatchObject({ok:false,error:{code:'CONFLICT'}});
  const saved=await call('read-rollups',{schema:'project',rollups:['completion'],filter:{node_ids:['P1']}});
  expect(saved.ok).toBe(true);expect(saved.data.rows[0]).toMatchObject({node:{id:'P1'},rollups:{completion:50},rollup_details:{completion:{numerator_count:1,denominator_count:2}}});
  const query=await call('query-nodes',{types:['task'],node_ids:['T1','T2','T3'],where:views.rollups[0].filter!.where});
  expect(query.data.nodes.map((n:any)=>n.id).sort()).toEqual(['T1','T3']);expect(query.data.total).toBe(2);
  const summary=await call('summarize-nodes',{filter:{node_ids:['P1']},relations:[{as:'work',direction:'incoming',field:'project',filter:{types:['task'],...views.rollups[0].filter},metrics:[{as:'pct',...views.rollups[0].metric}]}]});
  expect(summary.data.rows[0].relations.work).toMatchObject({metrics:{pct:50},metric_details:{pct:{numerator_count:1,denominator_count:2}}});
  const renamed=await call('rename-global-field',{old_name:'status',new_name:'state'});expect(renamed.ok).toBe(true);
  const renamedViews=(await call('describe-schema',{name:'project',include:['relationship_views']})).data.relationship_views;
  expect(renamedViews.state).toBe('valid');expect(JSON.stringify(renamedViews)).toContain('"state":{"eq":"done"}');
  const undone=await call('undo-operations',{operation_ids:[renamed.data.operation_id],dry_run:false});expect(undone.ok).toBe(true);
  expect((await call('describe-schema',{name:'project',include:['relationship_views']})).data.relationship_views_hash).toBe(hash);
});
it('returns useful INVALID_PARAMS envelopes for malformed and combined over-budget expressions',async()=>{
  for(const where of [{any:[]},{all:[{title_eq:'a'},{limit:1}]},{any:[{title_eq:'a'}]}]) {
    const r=await call('query-nodes',{where});expect(r.transportError).toBe(true);expect(r.message).toMatch(/Invalid|invalid/);expect(r).not.toHaveProperty('data');
  }
  const views=definitions();views.rollups=[];
  for(let i=0;i<8;i++)views.rollups.push({name:`r${i}`,relation:'tasks',filter:{where:{any:Array.from({length:7},()=>({fields:{status:{eq:'open'}}}))}},metric:{op:'count'}});
  expect((await call('update-schema',{name:'project',relationship_views:views,expected_relationship_views_hash:relationshipViewsHash(undefined)})).ok).toBe(true);
  const r=await call('read-rollups',{schema:'project',rollups:views.rollups.map(r=>r.name),filter:{where:{title_eq:'P1'}}});
  expect(r).toMatchObject({ok:false,error:{code:'INVALID_PARAMS',details:{reason:'nodes',limit:64}}});expect(r).not.toHaveProperty('data');
});
