import {expect,it} from 'vitest';
import {classificationDb} from '../helpers/classification-fixture.js';
import {classifyNodes} from '../../src/classification/read.js';
it('classifies ordered identities and preserves wrong-type and missing-node results',()=>{
 const db=classificationDb();
 const data=classifyNodes(db,{schema:'task',field:'status',node_ids:['G','A','F','E','P','missing','B']});
 expect(data.results.map(r=>r.node_id)).toEqual(['G','A','F','E','P','missing','B']);
 expect(data.results.map(r=>r.state)).toEqual(['unclassified','classified','unclassified','unclassified','not_applicable','missing_node','classified']);
 expect(data.results[0]).toMatchObject({reason:'unmapped',original:{kind:'value',value:'someday'}});
 expect(data.results[2]).toMatchObject({reason:'null'});expect(data.results[3]).toMatchObject({reason:'missing'});
 db.prepare("INSERT INTO node_types(node_id,schema_type) VALUES('A','project')").run();
 expect(classifyNodes(db,{schema:'project',field:'status',node_ids:['A']}).results[0]).toMatchObject({state:'unclassified',reason:'unmapped'});
 expect(()=>classifyNodes(db,{schema:'typo',field:'status',node_ids:['missing']})).toThrow();
 for(const node_ids of [[],['A','A'],Array.from({length:201},(_,i)=>`${i}`)]) expect(()=>classifyNodes(db,{schema:'task',field:'status',node_ids})).toThrow();
 db.close();
});
it('keeps a definition and node population in one SQLite snapshot across a concurrent writer',async()=>{
 const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {default:Database}=await import('better-sqlite3');const sqliteVec=await import('sqlite-vec');
 const {createClassificationReadContext}=await import('../../src/classification/read.js');const {buildNodeQuery}=await import('../../src/mcp/query-builder.js');
 const original=classificationDb();const dir=mkdtempSync(join(tmpdir(),'classification-snapshot-'));const file=join(dir,'test.db');writeFileSync(file,original.serialize());original.close();
 const reader=new Database(file),writer=new Database(file);sqliteVec.load(reader);sqliteVec.load(writer);reader.pragma('journal_mode=WAL');writer.pragma('journal_mode=WAL');
 try {
  reader.transaction(()=>{
   const context=createClassificationReadContext(reader);const definition=context.resolve({schema:'task',field:'status'});
   writer.prepare("UPDATE global_fields SET enum_groups=? WHERE name='status'").run(JSON.stringify({version:1,groups:[{name:'active',values:['finished']}]}));
   const query=buildNodeQuery({fields:{status:{in_group:{schema:'task',group:'active'}}}},reader,context);
   expect((reader.prepare(query.sql).all(...query.params) as {id:string}[]).map(n=>n.id).sort()).toEqual(['A','B']);
   expect(context.dependencies()[0].execution_hash).toBe(definition.execution_hash);
  }).deferred();
  expect(classifyNodes(reader,{schema:'task',field:'status',node_ids:['A','C']}).results.map(n=>n.state)).toEqual(['unclassified','classified']);
 } finally {reader.close();writer.close();rmSync(dir,{recursive:true,force:true});}
});

it('preserves malformed JSON and normalizes legacy JSON null consistently across reads and preview',async()=>{
 const {previewEnumGroupChange}=await import('../../src/classification/preview.js');
 const {globalClassificationHash}=await import('../../src/classification/definitions.js');const {getGlobalField}=await import('../../src/global-fields/crud.js');
 const {createClassificationReadContext}=await import('../../src/classification/read.js');const {buildNodeQuery}=await import('../../src/mcp/query-builder.js');
 const db=classificationDb();
 db.prepare("UPDATE node_fields SET value_json=? WHERE node_id='A' AND field_name='status'").run('{');
 db.prepare("UPDATE node_fields SET value_json=? WHERE node_id='B' AND field_name='status'").run('null');
 const before=db.prepare('SELECT * FROM node_fields').all();
 expect(classifyNodes(db,{schema:'task',field:'status',node_ids:['A','B']}).results).toEqual([
  {node_id:'A',state:'unclassified',reason:'invalid',original:{kind:'value',value:{value_json:'{'}}},
  {node_id:'B',state:'unclassified',reason:'null',original:{kind:'null'}},
 ]);
 const preview=previewEnumGroupChange(db,{field:'status',input:{enum_groups:{version:1,groups:[]},expected_enum_groups_hash:globalClassificationHash(getGlobalField(db,'status')!)}});
 expect(preview.changed_node_context_pairs).toBe(3);
 expect(preview.examples.some((e:any)=>e.node_id==='A'||e.node_id==='B')).toBe(false);
 db.transaction(()=>{const q=buildNodeQuery({fields:{status:{is_unclassified:{schema:'task'}}}},db,createClassificationReadContext(db));expect((db.prepare(q.sql).all(...q.params) as {id:string}[]).map(n=>n.id).sort()).toEqual(['A','B','E','F','G']);})();
 expect(db.prepare('SELECT * FROM node_fields').all()).toEqual(before);db.close();
});
