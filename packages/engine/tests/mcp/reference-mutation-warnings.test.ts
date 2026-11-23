import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { typedReferenceDb, addSecondProject } from '../helpers/typed-reference.js';
import { createTempVault } from '../helpers/vault.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { registerGetNode } from '../../src/mcp/tools/get-node.js';
import { registerCreateNode } from '../../src/mcp/tools/create-node.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { registerBatchMutate } from '../../src/mcp/tools/batch-mutate.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
let db: ReturnType<typeof typedReferenceDb>;
let vault: ReturnType<typeof createTempVault>;
let handlers: Record<string, (args: any) => Promise<any>>;
beforeEach(() => {
  db = typedReferenceDb(); addSecondProject(db); vault = createTempVault(); handlers = {};
  db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('reference_resolution_policy_version','2')").run();
  createGlobalField(db, { name: 'project', field_type: 'reference', reference_target: 'Project' });
  createSchemaDefinition(db, { name: 'Task', field_claims: [{field:'project'}] });
  const server = { tool: (name: string, _d: string, _s: unknown, fn: any) => { handlers[name] = async args => JSON.parse((await fn(args)).content[0].text); } } as unknown as McpServer;
  const lock = new WriteLockManager();
  registerGetNode(server, db);
  registerCreateNode(server, db, lock, vault.vaultPath);
  registerUpdateNode(server, db, lock, vault.vaultPath);
  registerBatchMutate(server, db, lock, vault.vaultPath);
});
afterEach(() => { db.close(); vault.cleanup(); });
const refs = (env: any) => env.warnings.filter((w: any) => w.code.startsWith('REFERENCE_'));
describe('reference mutation warning parity', () => {
  it('reports ambiguity in ordinary create/update previews, apply, and no-op', async () => {
    const params = { title:'Source', types:['Task'], fields:{project:'Example'} };
    const before = db.serialize();
    const preview = await handlers['create-node']({...params, dry_run:true});
    expect(preview.ok).toBe(true); expect(refs(preview)).toHaveLength(1);
    expect(db.serialize()).toEqual(before);
    const applied = await handlers['create-node'](params);
    expect(applied.ok).toBe(true); expect(refs(applied)[0].code).toBe('REFERENCE_AMBIGUOUS');
    const node_id = applied.data.node_id;
    const snapshot = db.serialize();
    const updatePreview = await handlers['update-node']({node_id, set_fields:{project:'Example'}, dry_run:true});
    expect(updatePreview.ok).toBe(true); expect(refs(updatePreview)).toHaveLength(1);
    expect(db.serialize()).toEqual(snapshot);
    const noop = await handlers['update-node']({node_id, set_fields:{project:'Example'}});
    expect(noop.ok).toBe(true); expect(refs(noop)).toHaveLength(1);
  });
  it('reports mismatch while preserving large Unicode raw values', async () => {
    const raw = '🌟'.repeat(4000);
    db.prepare('INSERT INTO nodes(id,file_path,title) VALUES (?,?,?)').run('U','Unicode.md',raw);
    const result = await handlers['create-node']({title:'Unicode source', types:['Task'], fields:{project:raw}});
    expect(result.ok).toBe(true);
    expect(refs(result)[0]).toMatchObject({code:'REFERENCE_TARGET_TYPE_MISMATCH',details:{raw_target_truncated:true}});
    expect(db.prepare('SELECT value_text FROM node_fields WHERE node_id=? AND field_name=?').get(result.data.node_id,'project')).toEqual({value_text:raw});
  });
  for (const dry_run of [true,false]) it(`aggregates batch diagnostics once with op_index (dry_run=${dry_run})`, async () => {
    // Two reference fields per operation exceed the response bound in only 26 operations.
    createGlobalField(db, { name:'project2', field_type:'reference', reference_target:'Project' });
    const operations = Array.from({length:26}, (_,i) => ({op:'create',params:{title:`Source ${i}`,types:['Task'],fields:{project:'Example',project2:'Example'}}}));
    const snapshot = db.serialize();
    const result = await handlers['batch-mutate']({operations,dry_run});
    expect(result.ok).toBe(true); expect(result.warnings).toHaveLength(50);
    expect(refs(result)).toHaveLength(49);
    expect(refs(result)[0].op_index).toBe(0); expect(refs(result)[48].op_index).toBe(24);
    expect(result.warnings.at(-1)).toMatchObject({code:'RESULT_TRUNCATED',details:{observed_count:52,reported_count:49}});
    if (dry_run) expect(db.serialize()).toEqual(snapshot);
  });
  it('retains warning parity for adding/removing types', async () => {
    createSchemaDefinition(db, {name:'Extra',field_claims:[]});
    const created = await handlers['create-node']({title:'Type source',types:['Task'],fields:{project:'Example'}});
    const node_id = created.data.node_id;
    for (const dry_run of [true,false]) {
      const added = await handlers['update-node']({node_id,add_types:['Extra'],dry_run});
      expect(added.ok).toBe(true); expect(refs(added)).toHaveLength(1);
    }
    for (const dry_run of [true,false]) {
      const removed = await handlers['update-node']({node_id,remove_types:['Extra'],dry_run});
      expect(removed.ok).toBe(true); expect(refs(removed)).toHaveLength(1);
    }
  });

  it('includes proposed self identity in create previews without fabricating a stored candidate ID', async () => {
    createSchemaDefinition(db, {name:'Project',field_claims:[{field:'project'}]});
    db.prepare("DELETE FROM nodes WHERE id='P2'").run();
    const result = await handlers['create-node']({title:'Example',directory:'New',types:['Project'],fields:{project:'Example'},dry_run:true});
    expect(result.ok).toBe(true);
    expect(refs(result)[0].details).toMatchObject({candidate_count:2});
    expect(refs(result)[0].details.candidates).toContainEqual({id:null,file_path:'New/Example.md',proposed:true});
  });

  for (const batch of [false, true]) for (const introduces of [false, true]) {
    it(`rename diagnostics describe the composed operation (batch=${batch}, introduces=${introduces})`, async () => {
      createSchemaDefinition(db, {name:'Project',field_claims:[{field:'project'}]});
      db.prepare("DELETE FROM nodes WHERE id='P2'").run();
      const created = await handlers['create-node']({title:introduces ? 'Other' : 'Example',directory:'Alternate',types:['Project'],fields:{project:'Example'}});
      expect(created.ok).toBe(true);
      const params = {node_id:created.data.node_id,set_title:introduces ? 'Example' : 'Other'};
      const call = (dry_run: boolean) => batch
        ? handlers['batch-mutate']({dry_run,operations:[{op:'update',params}]})
        : handlers['update-node']({...params,dry_run});
      const before = db.serialize();
      const preview = await call(true);
      expect(preview.ok).toBe(true); expect(db.serialize()).toEqual(before);
      const applied = await call(false);
      expect(applied.ok).toBe(true);
      const codes = introduces ? ['REFERENCE_AMBIGUOUS'] : [];
      expect(refs(preview).map((warning: any) => warning.code)).toEqual(codes);
      expect(refs(applied).map((warning: any) => warning.code)).toEqual(codes);
      if (batch && introduces) {
        expect(refs(preview)[0].op_index).toBe(0);
        expect(refs(applied)[0].op_index).toBe(0);
      }
    });
  }

  it('does not log diagnostics during read or preview operations', async () => {
    const created = await handlers['create-node']({title:'Quiet',types:['Task'],fields:{project:'Example'}});
    const warn = vi.spyOn(console,'warn').mockImplementation(() => {});
    try {
      await handlers['get-node']({node_id:created.data.node_id,include_embeds:false});
      await handlers['create-node']({title:'Preview',types:['Task'],fields:{project:'Example'},dry_run:true});
      await handlers['update-node']({node_id:created.data.node_id,set_fields:{project:'Example'},dry_run:true});
      await handlers['batch-mutate']({dry_run:true,operations:[{op:'update',params:{node_id:created.data.node_id,set_fields:{project:'Example'}}}]});
      expect(warn).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); }
  });

});
