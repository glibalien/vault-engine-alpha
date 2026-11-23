import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from '../helpers/db.js';
import { registerGetNode } from '../../src/mcp/tools/get-node.js';
import { registerProjectEvidence } from '../../src/mcp/tools/project-evidence.js';
import { registerMemoriesTools } from '../../src/mcp/tools/memories.js';
import { MemoryService } from '../../src/memories/service.js';
import { validateObservations } from '../../src/provenance/observations.js';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach(fn => fn()));
function handler(register: (server: McpServer) => void, name: string) {
  let call: (params: Record<string, unknown>) => Promise<any>;
  register({ tool: (n: string, _d: string, _s: unknown, fn: typeof call) => { if (n === name) call = fn; } } as unknown as McpServer);
  return async (params: Record<string, unknown>) => JSON.parse((await call(params)).content[0].text);
}
describe('opt-in observation reads', () => {
  it('returns body and observation from one WAL snapshot during a concurrent edit', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'provenance-read-'));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const seed = createTestDb();
    seed.prepare("INSERT INTO nodes(id,file_path,title,body,content_hash,version) VALUES ('n','N.md','N','before','before-hash',1)").run();
    const path = join(directory, 'test.db'); await seed.backup(path); seed.close();
    const writer = new Database(path); cleanup.push(() => writer.close()); writer.pragma('journal_mode=WAL');
    let edit = true;
    const reader = new Database(path, { verbose(sql) {
      if (edit && typeof sql === 'string' && sql.startsWith('SELECT * FROM node_fields')) {
        edit = false;
        writer.prepare("UPDATE nodes SET body='after',content_hash='after-hash',version=2 WHERE id='n'").run();
      }
    } }); cleanup.push(() => reader.close());
    const call = handler(server => registerGetNode(server, reader), 'get-node');
    const response = await call({ node_id: 'n', include_embeds: false, include_provenance: true });
    expect(response.ok).toBe(true);
    expect(response.data.body).toBe('before');
    expect(response.data.provenance_observation.native_version).toBe(1);
    expect(response.data.provenance_observation.content_hash).toBe('before-hash');
    expect(() => validateObservations(reader, [response.data.provenance_observation])).toThrow('PROVENANCE_OBSERVATION_CHANGED');
    const legacy = await call({ node_id: 'n', include_embeds: false });
    expect(legacy.data).not.toHaveProperty('provenance_observation');
  });
  it('adds bounded evidence metadata without changing the evidence hash', async () => {
    const db = createTestDb(); cleanup.push(() => db.close());
    db.prepare("INSERT INTO nodes(id,file_path,title) VALUES ('p','P.md','Project')").run();
    db.prepare("INSERT INTO node_types(node_id,schema_type) VALUES ('p','project')").run();
    const call = handler(server => registerProjectEvidence(server, db), 'project-evidence');
    const legacy = await call({ project: 'Project' });
    const tracked = await call({ project: 'Project', include_provenance: true });
    expect(tracked.ok).toBe(true);
    expect(tracked.data.evidence_hash).toBe(legacy.data.evidence_hash);
    expect(tracked.data.provenance_observations.nodes.p.source.native_id).toBe('p');
    expect(db.prepare('SELECT COUNT(*) AS n FROM provenance_observations').get()).toEqual({ n: 0 });
  });
  it('adds memory observations only on request', async () => {
    const db = createTestDb(); cleanup.push(() => db.close());
    db.prepare("INSERT INTO memories(id,source,scope,content,created_at,updated_at) VALUES (1,'owner','vault','Synthetic','2026-01-01','2026-01-01')").run();
    const call = handler(server => registerMemoriesTools(server, new MemoryService(db)), 'list-memories');
    const tracked = await call({ limit: 50, offset: 0, include_provenance: true });
    expect(tracked.data.memories[0].provenance_observation.source.native_id).toBe('1');
    const legacy = await call({ limit: 50, offset: 0 });
    expect(legacy.data.memories[0]).not.toHaveProperty('provenance_observation');
  });
  it('returns selected evidence and rename-sensitive observations from the same WAL snapshot', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'provenance-selected-read-'));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const seed = createTestDb();
    seed.prepare("INSERT INTO nodes(id,file_path,title) VALUES ('p','Before.md','Before')").run();
    seed.prepare("INSERT INTO node_types(node_id,schema_type) VALUES ('p','project')").run();
    const path = join(directory, 'test.db'); await seed.backup(path); seed.close();
    const writer = new Database(path); cleanup.push(() => writer.close()); writer.pragma('journal_mode=WAL');
    let edit = true;
    const reader = new Database(path, { verbose(sql) {
      if (edit && typeof sql === 'string' && sql.startsWith('SELECT id,version,content_hash,title,file_path')) {
        edit = false;
        writer.prepare("UPDATE nodes SET title='After',file_path='After.md' WHERE id='p'").run();
      }
    } }); cleanup.push(() => reader.close());
    const call = handler(server => registerProjectEvidence(server, reader), 'project-evidence');
    const response = await call({ project: 'p', include_provenance: true, provenance_node_ids: ['p'] });
    expect(response.ok).toBe(true); expect(edit).toBe(false);
    expect(response.data.project.title).toBe('Before');
    const observation = response.data.provenance_observations.nodes.p;
    expect(observation).toMatchObject({ label: 'Before', path: 'Before.md', observation_projection: 'node-token-v2' });
    expect(() => validateObservations(reader, [observation])).toThrow('PROVENANCE_OBSERVATION_CHANGED');
    const refreshed = await call({ project: 'p', include_provenance: true, provenance_node_ids: ['p'] });
    expect(refreshed.data.project.title).toBe('After');
    expect(refreshed.data.provenance_observations.nodes.p.label).toBe('After');
  });
});
