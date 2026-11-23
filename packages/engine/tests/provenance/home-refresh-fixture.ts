import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
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

/** Disposable real mutation/MCP boundary; only provider output is synthetic. */
export async function homeRefreshFixture(options: { replaceOnly?: boolean } = {}): Promise<{
  db: Database.Database; vault: ReturnType<typeof createTempVault>;
  mutate: (input: Parameters<typeof executeMutation>[3]) => ReturnType<typeof executeMutation>;
  project: ReturnType<typeof executeMutation>; home: ReturnType<typeof executeMutation>;
  service: ProvenanceService; call: (input: any) => Promise<any>;
  stage: (text?: string) => any; receipt: any; cleanup: () => void;
}> {
  const db: Database.Database = createTestDb();
  const vault = createTempVault();
  const writeLock = new WriteLockManager();
  db.prepare("INSERT INTO schemas(name,display_name,field_claims) VALUES ('project','Project','[]')").run();
  const mutate = (input: Parameters<typeof executeMutation>[3]) => executeMutation(db, writeLock, vault.vaultPath, input);
  const project = mutate({ source: 'tool', node_id: null, file_path: 'Project.md', title: 'Project', types: ['project'], fields: {}, body: 'Evidence.' });
  ensureWikiSchema(db, DEFAULT_WIKI_CONFIG);
  const home = mutate({ source: 'tool', node_id: null, file_path: 'Wikis/Project Wiki.md', title: 'Project Wiki', types: ['wiki'], fields: { wiki_for: 'Project' }, body: 'Human introduction.' });
  const service = new ProvenanceService(db);
  let handle!: (params: any) => Promise<any>;
  registerWikiReconcile({ tool: (_name: string, _description: string, _schema: unknown, fn: typeof handle) => { handle = fn; } } as unknown as McpServer,
    { db, writeLock, vaultPath: vault.vaultPath });
  const call = async (input: any) => JSON.parse((await handle(input)).content[0].text);
  function stage(text = 'Generated summary.') {
    const prepared = service.prepare({ attempt_key: randomUUID(), run_ref: randomUUID(), project_id: project.node_id, bundle: bundleFixture(), dry_run: false }) as PreparedReceipt;
    const sections = [{ name: 'Now', mode: 'replace' as const, content: text },
      ...(options.replaceOnly ? [] : [{ name: 'Log', mode: 'append' as const, content: `Log ${prepared.derivation_id}` }])];
    const provenance = service.stage({ derivation_id: prepared.derivation_id, bundle_digest: prepared.bundle_digest!, validated_sections: { now: text }, contribution: sections, generated_at: '2026-09-20T00:00:00Z', log_stamp: '2026-09-20' });
    return { project: 'Project', project_id: project.node_id, pages: [], reconcile_key: `wiki-reconcile:provenance-v1:${prepared.derivation_id}`,
      home: { expected_version: (db.prepare('SELECT version FROM nodes WHERE id=?').get(home.node_id) as { version: number }).version,
        sections, provenance, evidence_hash: 'new-evidence', curated_at: '2026-09-20T00:00:00Z', refresh_live: true }, dry_run: false };
  }
  const first = await call(stage());
  if (!first.ok) throw new Error(JSON.stringify(first));
  return { db, vault, mutate, project, home, service, call, stage, receipt: first.data.provenance_receipt,
    cleanup: () => { db.close(); vault.cleanup(); } };
}
