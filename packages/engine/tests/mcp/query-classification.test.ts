import {expect,it} from 'vitest';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {classificationDb} from '../helpers/classification-fixture.js';
import {registerQueryNodes} from '../../src/mcp/tools/query-nodes.js';
it('filters overlapping groups and unclassified values with exact counts and configuration errors',async()=>{
 const db=classificationDb();let handler:any;
 registerQueryNodes({registerTool:(_n:unknown,_c:unknown,h:unknown)=>handler=h} as unknown as McpServer,db);
 const query=async(input:unknown)=>JSON.parse((await handler(input)).content[0].text);
 const filter={fields:{status:{in_group:{schema:'task',group:'active'}}}};
 const result=await query({...filter,limit:1});
 expect(result.data.total).toBe(2);expect(result.data.nodes.map((n:any)=>n.id)).toEqual(['A']);
 expect(result.data.classification_dependencies[0]).toMatchObject({schema:'task',field:'status'});
 expect((await query({fields:{status:{is_unclassified:{schema:'task'}}}})).data.nodes.map((n:any)=>n.id)).toEqual(['E','F','G']);
 expect((await query({types:['project'],join_filters:[{direction:'incoming',rel_type:'project',target:filter}]})).data.nodes.map((n:any)=>n.id)).toEqual(['P']);
 expect((await query({node_ids:['absent'],fields:{status:{in_group:{schema:'task',group:'typo'}}}})).error.code).toBe('CLASSIFICATION_INVALID_CONFIG');
 expect((await query({fields:{status:{in_group:{schema:'task',group:'active',extra:true}}}})).error.code).toBe('INVALID_PARAMS');db.close();
});

it('embeds outside the snapshot and resolves membership and hashes together afterward',async()=>{
 const db=classificationDb();let handler:any;let release!:(value:Float32Array)=>void;
 const vector=new Promise<Float32Array>(resolve=>release=resolve);
 const embedder={embedQuery:async()=>{expect(db.inTransaction).toBe(false);return vector;},embedDocument:async()=>[],isReady:()=>true};
 registerQueryNodes({registerTool:(_n:unknown,_c:unknown,h:unknown)=>handler=h} as unknown as McpServer,db,undefined,embedder);
 const pending=handler({query:'C',fields:{status:{in_group:{schema:'task',group:'active'}}}});
 db.prepare("UPDATE global_fields SET enum_groups=? WHERE name='status'").run(JSON.stringify({version:1,groups:[{name:'active',values:['finished']}]}));
 release(new Float32Array(256).fill(0.1));
 const result=JSON.parse((await pending).content[0].text);
 expect(result.ok).toBe(true);expect(result.data.nodes.map((n:any)=>n.id)).toEqual(['C']);
 const read=await import('../../src/classification/read.js');
 expect(result.data.classification_dependencies[0].execution_hash).toBe(read.classifyNodes(db,{schema:'task',field:'status',node_ids:['C']}).execution_hash);db.close();
});
