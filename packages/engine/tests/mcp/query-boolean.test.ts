import { beforeEach, afterEach, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type Database from 'better-sqlite3';
import { makeSummaryDb } from '../helpers/summary-fixture.js';
import { registerQueryNodes } from '../../src/mcp/tools/query-nodes.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let db:Database.Database, server:McpServer, client:Client, vault:string;
beforeEach(async()=>{
  db=makeSummaryDb();vault=mkdtempSync(join(tmpdir(),'boolean-test-'));
  server=new McpServer({name:'boolean',version:'1'});
  registerQueryNodes(server,db);
  registerUpdateNode(server,db,new WriteLockManager(),vault);
  client=new Client({name:'test',version:'1'});
  const [a,b]=InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a),client.connect(b)]);
});
afterEach(async()=>{await client.close();await server.close();db.close();rmSync(vault,{recursive:true,force:true});});
async function call(name:string,args:Record<string,unknown>) {
  const result=await client.callTool({name,arguments:args});
  const text=(result.content as {text:string}[])[0].text;
  try{return JSON.parse(text);}catch{return {transportError:result.isError,text};}
}
it('advertises finite where schema and evaluates the real MCP read',async()=>{
  const listed=(await client.listTools()).tools.find(t=>t.name==='query-nodes')!;
  expect(listed.inputSchema.properties).toHaveProperty('where');
  expect(()=>JSON.stringify(listed.inputSchema)).not.toThrow();
  expect(JSON.stringify(listed.inputSchema).length).toBeLessThan(65536);
  const r=await call('query-nodes',{types:['task'],where:{any:[{fields:{estimate:{lt:0}}},{node_ids:['T3']}]}});
  expect(r.ok).toBe(true);expect(r.data.nodes.map((n:any)=>n.id).sort()).toEqual(['T2','T3']);expect(r.data.total).toBe(2);
});
it.each([true,false])('rejects unsupported compound bulk input before stripping dry_run=%s',async dry_run=>{
  for(const where of [null,{}, {any:[{node_ids:['T1']},{node_ids:['T2']}] }]) {
    for(const query of [{types:['task'],where},{join_filters:[{rel_type:'project',target:{where}}]}]) {
      const before=db.serialize(), files=readdirSync(vault);
      const r=await call('update-node',{query,set_fields:{status:'done'},dry_run});
      expect(r.ok===false||r.transportError===true).toBe(true);
      expect(JSON.stringify(r).toLowerCase()).toContain('where');
      expect(db.serialize().equals(before)).toBe(true);expect(readdirSync(vault)).toEqual(files);
    }
  }
});
it('retains unresolved warnings in a nested OR branch',async()=>{
  const r=await call('query-nodes',{where:{any:[{node_ids:['T1']},{join_filters:[{rel_type:'project',target:{types:['project']}}]}]}});
  expect(r.ok).toBe(true);expect(r.warnings.map((w:any)=>w.code)).toContain('CROSS_NODE_FILTER_UNRESOLVED');
});
