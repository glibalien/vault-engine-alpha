import { describe, it, expect } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerGetNode } from '../../src/mcp/tools/get-node.js';
import { typedReferenceDb, addSecondProject } from '../helpers/typed-reference.js';

const handler = (db: ReturnType<typeof typedReferenceDb>) => {
  let call: (params: any) => Promise<any>;
  registerGetNode({ tool: (_n: string, _d: string, _s: unknown, fn: typeof call) => { call = fn; } } as unknown as McpServer, db);
  return async (params: any) => JSON.parse((await call(params)).content[0].text);
};
describe('get-node stored relationship consistency', () => {
  for (const version of [1, 2]) for (const stored of ['W', null]) {
    it(`returns stored ${stored} in v${version} with coherent incoming and expansion and no writes`, async () => {
      const db = typedReferenceDb();
      db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)').run('reference_resolution_policy_version', String(version));
      db.prepare("INSERT INTO nodes(id,file_path,title) VALUES ('S','S.md','Source')").run();
      db.prepare("INSERT INTO global_fields(name,field_type,reference_target) VALUES ('project','reference','Project')").run();
      db.prepare("INSERT INTO node_fields(node_id,field_name,value_text) VALUES ('S','project','Example')").run();
      db.prepare("INSERT INTO relationships(source_id,target,rel_type,context,resolved_target_id) VALUES ('S','Example','project','project',?)").run(stored);
      expect(db.prepare("SELECT id FROM nodes WHERE title='Example'").get()).toEqual({ id: 'P1' });
      const before = db.serialize();
      const get = handler(db);
      const result = await get({ node_id: 'S', include_embeds: false, expand: { types: ['Wiki','Project'], direction: 'outgoing', max_nodes: 10 } });
      expect(result.data.relationships.outgoing.project[0]).toEqual({ target_id: stored, target_title: 'Example', context: 'project' });
      expect(Object.keys(result.data.expanded)).toEqual(stored ? [stored] : []);
      const incoming = await get({ node_id: 'W', include_embeds: false });
      expect(incoming.data.relationships.incoming.project?.map((r: any) => r.source_id) ?? []).toEqual(stored ? ['S'] : []);
      expect(result.warnings.some((w: any) => w.code === 'REFERENCE_RESOLUTION_STALE')).toBe(version === 2 || stored === null);
      expect(db.serialize()).toEqual(before);
      db.close();
    });
  }
  it('reports ambiguity and keeps NULL, and keeps top-level title selection', async () => {
    const db = typedReferenceDb(); addSecondProject(db);
    db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('reference_resolution_policy_version','2')").run();
    db.prepare("INSERT INTO global_fields(name,field_type,reference_target) VALUES ('project','reference','Project')").run();
    db.prepare("INSERT INTO node_fields(node_id,field_name,value_text) VALUES ('C','project','Example')").run();
    db.prepare("INSERT INTO relationships(source_id,target,rel_type,context) VALUES ('C','Example','project','project')").run();
    const get = handler(db);
    const result = await get({ node_id: 'C', include_embeds: false });
    expect(result.data.relationships.outgoing.project[0].target_id).toBeNull();
    expect(result.warnings.map((w: any) => w.code)).toEqual(['REFERENCE_AMBIGUOUS']);
    expect((await get({ title: 'Example', include_embeds: false })).data.id).toBe('P1');
    db.close();
  });
  it('does not reinterpret parser fallback links in malformed typed values as typed references', async () => {
    const db = typedReferenceDb(); addSecondProject(db);
    db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('reference_resolution_policy_version','2')").run();
    db.prepare("INSERT INTO global_fields(name,field_type,list_item_type,reference_target) VALUES ('project','list','reference','Project')").run();
    db.prepare("INSERT INTO node_fields(node_id,field_name,value_text) VALUES ('C','project','[[Example]]')").run();
    db.prepare("INSERT INTO relationships(source_id,target,rel_type,context,resolved_target_id) VALUES ('C','Example','project','project','W')").run();
    const result = await handler(db)({node_id:'C',include_embeds:false});
    expect(result.warnings).toEqual([]);
    expect(result.data.relationships.outgoing.project[0].target_id).toBe('W');
    db.close();
  });

});
