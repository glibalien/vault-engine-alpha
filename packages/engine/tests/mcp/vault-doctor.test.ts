import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTestDb } from '../helpers/db.js';
import { upgradeForAttachmentTranscripts, upgradeForMaterializedTranscripts } from '../../src/db/migrate.js';
import { registerVaultDoctor } from '../../src/mcp/tools/vault-doctor.js';
import { writeLastBackup } from '../../src/db/maintenance.js';
import type Database from 'better-sqlite3';

async function callTool(server: McpServer, name: string, args: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool.callback ? tool.callback(args) : tool.handler(args);
}

async function doctor(server: McpServer, args: Record<string, unknown> = {}) {
  const result = await callTool(server, 'vault-doctor', args);
  return JSON.parse(result.content[0].text);
}

function invariant(payload: { data: { invariants: Array<{ name: string; ok: boolean; count: number }> } }, name: string) {
  const inv = payload.data.invariants.find(i => i.name === name);
  if (!inv) throw new Error(`invariant ${name} missing from report`);
  return inv;
}

function seedNodeWithEmbedding(db: Database.Database, id: string): void {
  db.prepare('INSERT INTO nodes (id, file_path, title) VALUES (?, ?, ?)').run(id, `${id}.md`, id);
  const res = db.prepare(
    "INSERT INTO embedding_meta (node_id, source_type, source_hash, chunk_index, extraction_ref, embedded_at) VALUES (?, 'node', 'h', 0, NULL, '2026-01-01')"
  ).run(id);
  db.prepare('INSERT INTO embedding_vec (id, vector) VALUES (?, ?)')
    .run(BigInt(res.lastInsertRowid), new Uint8Array(1024));
}

describe('vault-doctor', () => {
  let db: Database.Database;
  let server: McpServer;

  beforeEach(() => {
    db = createTestDb();
    server = new McpServer({ name: 'test', version: '0' });
    registerVaultDoctor(server, db);
  });
  afterEach(() => db.close());

  it('reports a healthy DB: quick_check ok, sizes, table rows, all invariants ok', async () => {
    seedNodeWithEmbedding(db, 'n1');
    const payload = await doctor(server);

    expect(payload.ok).toBe(true);
    expect(payload.data.integrity).toEqual({ check: 'quick_check', ok: true, messages: [] });
    expect(payload.data.size.db_bytes).toBeGreaterThan(0);
    expect(payload.data.size.free_bytes).toBeGreaterThanOrEqual(0);
    expect(payload.data.size.wal_bytes).toBe(0); // :memory: has no -wal file
    expect(payload.data.size.table_rows.nodes).toBe(1);
    expect(payload.data.size.table_rows.embedding_vec).toBe(1);
    expect(Object.keys(payload.data.size.table_rows)).not.toContain('embedding_vec_chunks'); // shadow tables excluded
    for (const inv of payload.data.invariants) {
      if (inv.name !== 'orphan_field_values') expect(inv.ok).toBe(true);
    }
  });

  it('full:true runs integrity_check instead', async () => {
    const payload = await doctor(server, { full: true });
    expect(payload.data.integrity.check).toBe('integrity_check');
    expect(payload.data.integrity.ok).toBe(true);
  });

  it('flags embedding_meta rows whose node was deleted behind its back', async () => {
    seedNodeWithEmbedding(db, 'n1');
    db.pragma('foreign_keys = OFF');
    db.prepare("DELETE FROM nodes WHERE id = 'n1'").run();
    db.pragma('foreign_keys = ON');

    const payload = await doctor(server);
    expect(invariant(payload, 'embedding_meta_dangling_node')).toMatchObject({ ok: false, count: 1 });
  });

  it('flags embedding_vec/meta desync in both directions', async () => {
    // vec row with no meta
    db.prepare('INSERT INTO embedding_vec (id, vector) VALUES (?, ?)').run(999n, new Uint8Array(1024));
    // meta row with no vec
    db.prepare("INSERT INTO nodes (id, file_path, title) VALUES ('n2', 'n2.md', 'N2')").run();
    db.prepare(
      "INSERT INTO embedding_meta (node_id, source_type, source_hash, chunk_index, extraction_ref, embedded_at) VALUES ('n2', 'node', 'h', 0, NULL, '2026-01-01')"
    ).run();

    const payload = await doctor(server);
    expect(invariant(payload, 'embedding_vec_meta_sync')).toMatchObject({ ok: false, count: 2 });
  });

  it('flags dangling resolved_target_id', async () => {
    db.prepare("INSERT INTO nodes (id, file_path, title) VALUES ('a', 'a.md', 'A'), ('b', 'b.md', 'B')").run();
    db.prepare(
      "INSERT INTO relationships (source_id, target, rel_type, resolved_target_id) VALUES ('a', 'B', 'wikilink', 'b')"
    ).run();
    db.pragma('foreign_keys = OFF'); // FK ON would SET NULL — simulate the missed-refresh case
    db.prepare("DELETE FROM nodes WHERE id = 'b'").run();
    db.pragma('foreign_keys = ON');

    const payload = await doctor(server);
    expect(invariant(payload, 'relationships_dangling_resolved_target')).toMatchObject({ ok: false, count: 1 });
  });

  it('flags unresolved references whose target normalizes to an existing note (near-miss)', async () => {
    db.prepare(
      "INSERT INTO nodes (id, file_path, title) VALUES ('proj', 'Projects/Lantern Inspections - Checklists.md', 'Lantern Inspections - Checklists'), ('src', 'src.md', 'Src')"
    ).run();
    db.prepare(
      "INSERT INTO relationships (source_id, target, rel_type, resolved_target_id) VALUES ('src', 'Lantern Inspections / Checklists', 'project', NULL)"
    ).run();
    // A genuinely-missing target must NOT count.
    db.prepare(
      "INSERT INTO relationships (source_id, target, rel_type, resolved_target_id) VALUES ('src', 'Never Existed', 'wiki-link', NULL)"
    ).run();

    const payload = await doctor(server);
    expect(invariant(payload, 'unresolved_near_miss')).toMatchObject({ ok: false, count: 1 });
  });

  it('flags dangling materialized_node_id; table-less DBs report ok', async () => {
    // createTestDb has no attachment_transcripts — guard must hold:
    let payload = await doctor(server);
    expect(invariant(payload, 'transcript_dangling_materialized_node')).toMatchObject({ ok: true, count: 0 });

    upgradeForAttachmentTranscripts(db);
    upgradeForMaterializedTranscripts(db);
    db.prepare(
      "INSERT INTO attachment_transcripts (embed_ref, content_hash, extracted_text, media_type, extractor_id, captured_at, materialized_node_id) VALUES ('![[x.m4a]]', 'h', 't', 'audio', 'deepgram', '2026-01-01', 'ghost')"
    ).run();

    payload = await doctor(server);
    expect(invariant(payload, 'transcript_dangling_materialized_node')).toMatchObject({ ok: false, count: 1 });
  });

  it('flags memory_embedding_vec rows with no owning memories.vec_id', async () => {
    // vec row with no memories row pointing at it
    db.prepare('INSERT INTO memory_embedding_vec (id, vector) VALUES (?, ?)').run(999n, new Uint8Array(1024));

    let payload = await doctor(server);
    expect(invariant(payload, 'memories_vec_orphans')).toMatchObject({ ok: false, count: 1 });

    // A referenced vec row must NOT count.
    db.prepare('INSERT INTO memory_embedding_vec (id, vector) VALUES (?, ?)').run(1n, new Uint8Array(1024));
    db.prepare(
      "INSERT INTO memories (source, scope, content, vec_id, created_at, updated_at) VALUES ('user', 'vault', 'c', 1, '2026-01-01', '2026-01-01')"
    ).run();
    db.prepare('DELETE FROM memory_embedding_vec WHERE id = 999').run();

    payload = await doctor(server);
    expect(invariant(payload, 'memories_vec_orphans')).toMatchObject({ ok: true, count: 0 });
  });

  it('excludes memory_embedding_vec and memories_fts shadow tables from table_rows', async () => {
    const payload = await doctor(server);
    expect(Object.keys(payload.data.size.table_rows)).not.toContain('memory_embedding_vec_chunks');
    expect(Object.keys(payload.data.size.table_rows)).not.toContain('memories_fts_data');
  });

  it('reports orphan field values as informational (ok stays true)', async () => {
    db.prepare("INSERT INTO nodes (id, file_path, title) VALUES ('n1', 'a.md', 'A')").run();
    db.prepare("INSERT INTO node_fields (node_id, field_name, value_text) VALUES ('n1', 'stray', 'v')").run();
    const payload = await doctor(server);
    expect(invariant(payload, 'orphan_field_values')).toMatchObject({ ok: true, count: 1 });
  });

  it('surfaces backup status from meta + backup dir listing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-doctor-bk-'));
    try {
      writeFileSync(join(dir, 'vault-2026-06-08.db'), 'x');
      writeFileSync(join(dir, 'vault-2026-06-09.db'), 'x');
      writeLastBackup(db, { at: '2026-06-09T03:00:00.000Z', ok: true, path: join(dir, 'vault-2026-06-09.db'), bytes: 1 });
      process.env.VAULT_BACKUP_DIR = dir;

      const payload = await doctor(server);
      expect(payload.data.backup).toEqual({
        last_backup_at: '2026-06-09T03:00:00.000Z',
        last_backup_ok: true,
        backup_count: 2,
      });
    } finally {
      delete process.env.VAULT_BACKUP_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports null backup status when no backup has ever run', async () => {
    const payload = await doctor(server);
    expect(payload.data.backup.last_backup_at).toBeNull();
    expect(payload.data.backup.last_backup_ok).toBeNull();
  });

  it('memories v3: reports dangling superseded_by, orphaned node-scope, band count, and stock', async () => {
    // Arrange directly in SQL — these states are only reachable via purge / FK backstop.
    const NOW = '2026-01-01T00:00:00.000Z';
    db.prepare(
      `INSERT INTO memories (source, scope, content, created_at, updated_at, valid_at, superseded_by)
       VALUES ('chat','vault','points at purged', ?, ?, ?, 424242)`,
    ).run(NOW, NOW, NOW);
    db.prepare(
      `INSERT INTO memories (source, scope, node_id, content, created_at, updated_at, valid_at)
       VALUES ('chat','node', NULL, 'set-null backstop fired', ?, ?, ?)`,
    ).run(NOW, NOW, NOW);
    const payload = await doctor(server);
    expect(invariant(payload, 'memories_dangling_supersede').ok).toBe(false);
    expect(invariant(payload, 'memories_dangling_supersede').count).toBe(1);
    expect(invariant(payload, 'memories_orphan_node_scope').ok).toBe(false);
    expect(invariant(payload, 'memories_orphan_node_scope').count).toBe(1);
    expect(invariant(payload, 'memories_near_pair_band').ok).toBe(true);
    expect(invariant(payload, 'memories_near_pair_band').count).toBe(0);
    const stock = payload.data.invariants.find((i: { name: string }) => i.name === 'memories_stock');
    expect(stock.ok).toBe(true);
    expect(stock.detail).toContain('chat: 2 live');
  });
});
