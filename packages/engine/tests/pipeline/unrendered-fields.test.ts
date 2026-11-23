import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { loadNodeState } from '../../src/pipeline/node-state.js';
import { processFileChange } from '../../src/sync/watcher.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { indexFile } from '../../src/indexer/indexer.js';
import { ensureWikiSchema } from '../../src/wiki/bootstrap.js';
import { DEFAULT_WIKI_CONFIG } from '../../src/wiki/config.js';

// #547: the wiki build fingerprints live in the database only.
describe('unrendered fields', () => {
  let db: Database.Database;
  let vaultPath: string;
  let cleanup: () => void;
  let writeLock: WriteLockManager;
  const homePath = 'Wikis/Alpha Wiki.md';

  beforeEach(() => {
    db = createTestDb();
    ({ vaultPath, cleanup } = createTempVault());
    writeLock = new WriteLockManager({ recentWriteTtlMs: 1 });
    db.prepare("INSERT INTO schemas (name, display_name, field_claims) VALUES ('project', 'Project', '[]')").run();
    ensureWikiSchema(db, DEFAULT_WIKI_CONFIG);
    mkdirSync(join(vaultPath, 'Wikis'), { recursive: true });
  });

  afterEach(() => {
    db.close();
    cleanup();
  });

  function createHome(fields: Record<string, unknown>): string {
    return executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: null,
      file_path: homePath,
      title: 'Alpha Wiki',
      types: ['wiki'],
      fields: { wiki_for: 'Alpha', ...fields },
      body: 'Home prose.\n',
    }).node_id;
  }

  function writeFields(nodeId: string, patch: Record<string, unknown>): void {
    const state = loadNodeState(db, nodeId)!;
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool',
      node_id: nodeId,
      file_path: state.file_path,
      title: state.title,
      types: state.types,
      fields: { ...state.currentFields, ...patch },
      body: state.body,
      raw_field_texts: state.rawFieldTexts,
    });
  }

  function storedField(nodeId: string, name: string): string | null {
    const row = db.prepare('SELECT value_text FROM node_fields WHERE node_id = ? AND field_name = ?')
      .get(nodeId, name) as { value_text: string | null } | undefined;
    return row?.value_text ?? null;
  }

  function version(nodeId: string): number {
    return (db.prepare('SELECT version FROM nodes WHERE id = ?').get(nodeId) as { version: number }).version;
  }

  function file(): string {
    return readFileSync(join(vaultPath, homePath), 'utf-8');
  }

  it('stores the build fingerprints without writing them to the file', () => {
    const id = createHome({
      wiki_evidence_hash: 'ev-1',
      wiki_topology_hash: 'topo-1',
      wiki_reconcile_key: '{"key":"k"}',
      wiki_curated_at: '2026-11-15T12:00:00.000Z',
    });

    expect(storedField(id, 'wiki_evidence_hash')).toBe('ev-1');
    expect(storedField(id, 'wiki_topology_hash')).toBe('topo-1');
    expect(storedField(id, 'wiki_reconcile_key')).toBe('{"key":"k"}');
    expect(file()).not.toMatch(/wiki_evidence_hash|wiki_topology_hash|wiki_reconcile_key/);
    expect(file()).toMatch(/wiki_curated_at:/);
  });

  it('commits a write that changes only a fingerprint, leaving the file as it is', () => {
    const id = createHome({ wiki_evidence_hash: 'ev-1' });
    const before = file();
    const past = new Date('2026-01-01T00:00:00Z');
    utimesSync(join(vaultPath, homePath), past, past);
    const versionBefore = version(id);

    writeFields(id, { wiki_evidence_hash: 'ev-2' });

    expect(storedField(id, 'wiki_evidence_hash')).toBe('ev-2');
    expect(version(id)).toBe(versionBefore + 1);
    expect(file()).toBe(before);
    expect(statSync(join(vaultPath, homePath)).mtime.getTime()).toBe(past.getTime());
  });

  it('is still a no-op when nothing changes', () => {
    const id = createHome({ wiki_evidence_hash: 'ev-1' });
    const versionBefore = version(id);

    writeFields(id, {});

    expect(version(id)).toBe(versionBefore);
  });

  it('keeps the stored fingerprints when the watcher reads a hand edit', () => {
    const id = createHome({ wiki_evidence_hash: 'ev-1', wiki_topology_hash: 'topo-1' });
    const abs = join(vaultPath, homePath);
    writeFileSync(abs, file().replace('Home prose.', 'Home prose, edited by hand.'), 'utf-8');

    processFileChange(abs, homePath, db, writeLock, vaultPath);

    expect(loadNodeState(db, id)!.body).toContain('edited by hand');
    expect(storedField(id, 'wiki_evidence_hash')).toBe('ev-1');
    expect(storedField(id, 'wiki_topology_hash')).toBe('topo-1');
  });

  it('keeps the stored value over one a file still carries', () => {
    const id = createHome({ wiki_evidence_hash: 'ev-1' });
    const abs = join(vaultPath, homePath);
    writeFileSync(abs, file().replace('wiki_for:', 'wiki_evidence_hash: typed-by-hand\nwiki_for:'), 'utf-8');

    processFileChange(abs, homePath, db, writeLock, vaultPath);

    expect(storedField(id, 'wiki_evidence_hash')).toBe('ev-1');
  });

  it('reads a fingerprint from a file written before #547 when nothing is stored', () => {
    const abs = join(vaultPath, homePath);
    writeFileSync(abs, '---\ntypes:\n  - wiki\nwiki_for: "[[Alpha]]"\nwiki_evidence_hash: legacy-1\n---\nHome prose.\n', 'utf-8');

    processFileChange(abs, homePath, db, writeLock, vaultPath);

    const id = (db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(homePath) as { id: string }).id;
    expect(storedField(id, 'wiki_evidence_hash')).toBe('legacy-1');
  });

  it('drops the line from such a file at the next Engine write', () => {
    const abs = join(vaultPath, homePath);
    writeFileSync(abs, '---\ntypes:\n  - wiki\nwiki_for: "[[Alpha]]"\nwiki_evidence_hash: legacy-1\n---\nHome prose.\n', 'utf-8');
    processFileChange(abs, homePath, db, writeLock, vaultPath);
    const id = (db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(homePath) as { id: string }).id;

    writeFields(id, { wiki_curated_at: '2026-11-15T12:00:00.000Z' });

    expect(file()).not.toMatch(/wiki_evidence_hash/);
    expect(storedField(id, 'wiki_evidence_hash')).toBe('legacy-1');
  });

  it('keeps the stored fingerprints when the startup index reads the file', () => {
    const id = createHome({ wiki_evidence_hash: 'ev-1', wiki_reconcile_key: '{"key":"k"}' });
    const abs = join(vaultPath, homePath);
    writeFileSync(abs, file().replace('Home prose.', 'Home prose, edited while the Engine was down.'), 'utf-8');

    indexFile(abs, vaultPath, db);

    expect(loadNodeState(db, id)!.body).toContain('while the Engine was down');
    expect(storedField(id, 'wiki_evidence_hash')).toBe('ev-1');
    expect(storedField(id, 'wiki_reconcile_key')).toBe('{"key":"k"}');
  });
});
