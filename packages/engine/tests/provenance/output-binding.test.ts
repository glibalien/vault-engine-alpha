import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { ensureWikiSchema } from '../../src/wiki/bootstrap.js';
import { DEFAULT_WIKI_CONFIG } from '../../src/wiki/config.js';
import { registerWikiReconcile } from '../../src/mcp/tools/wiki-reconcile.js';
import { ProvenanceService } from '../../src/provenance/service.js';
import type { PreparedReceipt } from '../../src/provenance/types.js';
import { bundleFixture } from './fixture.js';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).reverse().forEach(fn => fn()));
function fixture() {
  const db = createTestDb(); const vault = createTempVault(); const writeLock = new WriteLockManager();
  cleanups.push(() => { db.close(); vault.cleanup(); });
  db.prepare("INSERT INTO schemas(name,display_name,field_claims) VALUES ('project','Project','[]')").run();
  const project = executeMutation(db, writeLock, vault.vaultPath, { source: 'tool', node_id: null,
    file_path: 'Project.md', title: 'Project', types: ['project'], fields: {}, body: 'Original evidence.' });
  ensureWikiSchema(db, DEFAULT_WIKI_CONFIG);
  const home = executeMutation(db, writeLock, vault.vaultPath, { source: 'tool', node_id: null,
    file_path: 'Wikis/Project Wiki.md', title: 'Project Wiki', types: ['wiki'], fields: { wiki_for: 'Project' }, body: 'Human introduction.' });
  const service = new ProvenanceService(db);
  const prepared = service.prepare({ attempt_key: randomUUID(), run_ref: randomUUID(), project_id: project.node_id,
    bundle: bundleFixture(), dry_run: false }) as PreparedReceipt;
  const sections = [{ name: 'Now', mode: 'replace' as const, content: 'Generated summary.' }, { name: 'Log', mode: 'append' as const, content: '2026-09-17 — Generated.' }];
  const binding = service.stage({ derivation_id: prepared.derivation_id, bundle_digest: prepared.bundle_digest!,
    validated_sections: { now: 'Generated summary.', log_entry: '2026-09-17 — Generated.' }, contribution: sections,
    generated_at: '2026-09-17T00:00:00Z', log_stamp: '2026-09-17' });
  let handle: (params: unknown) => Promise<any>;
  registerWikiReconcile({ tool: (_n: string, _d: string, _s: unknown, fn: typeof handle) => { handle = fn; } } as unknown as McpServer,
    { db, writeLock, vaultPath: vault.vaultPath });
  const input = { project: 'Project', project_id: project.node_id, pages: [],
    reconcile_key: `wiki-reconcile:provenance-v1:${binding.derivation_id}`,
    home: { expected_version: 1, sections, provenance: binding, evidence_hash: 'evidence', curated_at: '2026-09-17T00:00:00Z', refresh_live: true }, dry_run: false };
  const call = async (params = input) => JSON.parse((await handle(params)).content[0].text);
  return { db, service, home, project, input, call, path: join(vault.vaultPath, 'Wikis/Project Wiki.md') };
}
describe('atomic home provenance binding', () => {
  it('commits once and replays the receipt after human edits and deletion', async () => {
    const f = fixture();
    const committed = await f.call();
    expect(committed.ok, JSON.stringify(committed)).toBe(true);
    expect(committed.data.provenance_receipt.output_node_id).toBe(f.home.node_id);
    const after = readFileSync(f.path, 'utf8');
    const replay = await f.call();
    expect(replay.data.provenance_receipt).toEqual(committed.data.provenance_receipt);
    expect(replay.data.reused).toBe(true);
    expect(readFileSync(f.path, 'utf8')).toBe(after);
    f.db.prepare("UPDATE nodes SET body='Human changed it',version=version+1 WHERE id=?").run(f.home.node_id);
    const edited = await f.call();
    expect(edited.data.provenance_receipt).toEqual(committed.data.provenance_receipt);
    expect(edited.data.current_output).toBe('changed');
    f.db.prepare('DELETE FROM nodes WHERE id=?').run(f.home.node_id); unlinkSync(f.path);
    expect((await f.call()).data.current_output).toBe('missing');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM provenance_outputs').get()).toEqual({ n: 1 });
  });
  it('replays the historical receipt without claiming a duplicate section is current', async () => {
    const f = fixture(); const first = await f.call(); expect(first.ok).toBe(true);
    f.db.prepare("UPDATE nodes SET body=body || ? WHERE id=?").run('\n<!-- ve:managed:Now -->\nConflicting\n<!-- /ve:managed:Now -->', f.home.node_id);
    const replay = await f.call();
    expect(replay.data.provenance_receipt).toEqual(first.data.provenance_receipt);
    expect(replay.data.current_output).toBe('unknown');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM provenance_outputs').get()).toEqual({ n: 1 });
  });
  it('rolls back wiki files, versions and stamps if receipt insertion fails', async () => {
    const f = fixture(); const before = readFileSync(f.path, 'utf8');
    f.db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON provenance_outputs BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    expect((await f.call()).ok).toBe(false);
    expect(readFileSync(f.path, 'utf8')).toBe(before);
    expect(f.db.prepare('SELECT version,body FROM nodes WHERE id=?').get(f.home.node_id)).toEqual({ version: 1, body: 'Human introduction.' });
    expect(f.db.prepare('SELECT state FROM provenance_derivations').get()).toEqual({ state: 'result_staged' });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM provenance_outputs').get()).toEqual({ n: 0 });
  });
  it('rejects altered output and changed concurrency guards on a committed retry', async () => {
    const f = fixture(); expect((await f.call()).ok).toBe(true);
    const changed = await f.call({ ...f.input, home: { ...f.input.home, expected_version: 2 } });
    expect(changed.error?.code).toBe('CONFLICT');
    const other = fixture(); other.input.home.sections[0]!.content = 'Uncaptured';
    expect((await other.call()).ok).toBe(false);
    expect(other.db.prepare('SELECT COUNT(*) AS n FROM provenance_outputs').get()).toEqual({ n: 0 });
  });
  it('keeps previews read-only', async () => {
    const f = fixture(); const before = readFileSync(f.path, 'utf8');
    expect((await f.call({ ...f.input, dry_run: true })).ok).toBe(true);
    expect(readFileSync(f.path, 'utf8')).toBe(before);
    expect(f.db.prepare('SELECT state FROM provenance_derivations').get()).toEqual({ state: 'result_staged' });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM provenance_outputs').get()).toEqual({ n: 0 });
  });
});
