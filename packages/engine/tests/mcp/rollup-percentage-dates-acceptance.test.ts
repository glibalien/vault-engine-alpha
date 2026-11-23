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
  return JSON.parse((r.content as Array<{ text: string }>)[0].text);
}

const clock={time_zone:'America/New_York',as_of:'2026-09-19T16:00:00Z'};
const views=()=>({...projectViews(),rollups:[
 {name:'completion',relation:'tasks',filter:{fields:{status:{one_of:['done','open','in-progress']}}},metric:{op:'percentage',matching_filter:{fields:{status:{eq:'done'}}}}},
 {name:'overdue',relation:'tasks',filter:{fields:{status:{one_of:['open','in-progress']},due:{date_window:{to_days:0}}}},metric:{op:'count'}}
]});
it('installs discoverable definitions and reads exact percentages and dates through real MCP',async()=>{
 const definitions=views();
 const args={name:'project',relationship_views:definitions,expected_relationship_views_hash:relationshipViewsHash(undefined)};
 const before=db.serialize();expect((await call('update-schema',{...args,dry_run:true})).ok).toBe(true);expect(db.serialize()).toEqual(before);
 expect((await call('update-schema',args)).ok).toBe(true);
 const discovery=await call('describe-schema',{name:'project',include:['relationship_views']});expect(discovery.ok).toBe(true);
 const request={schema:'project',rollups:['completion','overdue'],evaluation_context:clock,sort:{by:'rollup',name:'completion',order:'desc'},limit:1};
 const r=await call('read-rollups',request);expect(r.ok).toBe(true);
 expect(r.data.rows[0]).toMatchObject({node:{id:'P1'},rollups:{completion:100/3,overdue:1},rollup_details:{completion:{numerator_count:1,denominator_count:3}}});
 expect(r.data.evaluation_context.calendar_date).toBe('2026-09-19');
 const summary=await call('summarize-nodes',{evaluation_context:clock,filter:{node_ids:['P1']},relations:[{as:'work',direction:'incoming',field:'project',filter:definitions.rollups[0].filter,metrics:[{as:'p',...definitions.rollups[0].metric}]}]});
 expect(summary.ok).toBe(true);expect(summary.data.rows[0].relations.work.metrics.p).toBe(r.data.rows[0].rollups.completion);
 expect(summary.data.rows[0].relations.work.metric_details.p).toEqual(r.data.rows[0].rollup_details.completion);
 const next=await call('read-rollups',{...request,offset:2,evaluation_context:{time_zone:r.data.evaluation_context.time_zone,as_of:r.data.evaluation_context.as_of}});
 expect(next.data.rows[0].rollups.completion).toBeNull();
 expect(next.data.rows[0].rollup_details.completion).toEqual({numerator_count:0,denominator_count:0});
 const missing=await call('read-rollups',{schema:'project',rollups:['overdue']});expect(missing).toMatchObject({ok:false,error:{code:'INVALID_PARAMS'}});
 expect(missing).not.toHaveProperty('data');
});
it('advertises additive input shapes and rejects malformed context through domain envelopes',async()=>{
 const tools=(await client.listTools()).tools;
 for(const name of ['read-rollups','summarize-nodes']) {
  const tool=tools.find(t=>t.name===name)!;
  expect(tool.inputSchema.properties).toHaveProperty('evaluation_context');
  expect(tool.annotations).toMatchObject({readOnlyHint:true,idempotentHint:true});
 }
 const r=await call('summarize-nodes',{evaluation_context:{as_of:'2026-09-19T00:00:00Z'},relations:[{as:'r',direction:'incoming',field:'project',metrics:[{as:'p',op:'percentage',matching_filter:{}}]}]});
 expect(r).toMatchObject({ok:false,error:{code:'INVALID_PARAMS'}});
});
it('keeps arbitrary own matching-filter names and null-marker precedence through MCP',async()=>{
 db.prepare('INSERT INTO node_fields (node_id,field_name,value_number,source) VALUES (?,?,?,?)').run('T1','__proto__',42,'frontmatter');
 db.prepare('INSERT INTO node_explicit_null_fields (node_id,field_name) VALUES (?,?)').run('T1','__proto__');
 const fields=JSON.parse('{"__proto__":{"eq":42}}');
 const r=await call('summarize-nodes',{filter:{node_ids:['P1']},relations:[{as:'r',direction:'incoming',field:'project',metrics:[{as:'p',op:'percentage',matching_filter:{fields}}]}]});
 expect(r.ok).toBe(true);expect(r.data.rows[0].relations.r.metrics.p).toBe(0);
 expect(r.data.rows[0].relations.r.metric_details.p).toEqual({numerator_count:0,denominator_count:3});
});
