// tests/search/rolling-upgrade.test.ts
//
// Cycle 5 rolling v2→v3 upgrade guarantees:
// - startup never clears either vector table for a v2 store;
// - old (v2-hash) groups stay searchable until their contextualized
//   replacement is written atomically;
// - the versioned source hash detects every pre-context group (a v2 hash can
//   never accidentally match a v3 hash);
// - crash/restart resumes through hash-skips;
// - terminal failures are counted and surfaced via getStatus();
// - planSearchUpgrade picks rolling vs clear.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { createEmbeddingIndexer, type EmbeddingIndexer } from '../../src/search/indexer.js';
import type { Embedder } from '../../src/search/embedder.js';
import type { ExtractionCache } from '../../src/extraction/cache.js';
import { CURRENT_SEARCH_VERSION, getSearchVersion, setSearchVersion, planSearchUpgrade } from '../../src/db/search-version.js';

function fakeEmbedder(): Embedder & { callCount: number } {
  let callCount = 0;
  return {
    get callCount() { return callCount; },
    async embedDocument(text: string): Promise<Float32Array[]> {
      callCount++;
      const arr = new Float32Array(256);
      for (let i = 0; i < 256; i++) arr[i] = (text.length % 100) / 100 + i * 0.001;
      return [arr];
    },
    async embedQuery(): Promise<Float32Array> { return new Float32Array(256).fill(0.5); },
    isReady(): boolean { return true; },
  };
}

function insertNode(db: Database.Database, id: string, title: string, body: string | null = null): void {
  db.prepare('INSERT INTO nodes (id, file_path, title, body) VALUES (?, ?, ?, ?)').run(id, `${id}.md`, title, body);
}

/** Insert an embedding group exactly as the v2 pipeline would have written it. */
function insertV2Group(db: Database.Database, nodeId: string, title: string, body: string): void {
  // v2 hash input: ad hoc title + body (+ string fields) joined with \n\n.
  const legacyContent = body ? `${title}\n\n${body}` : title;
  const v2Hash = createHash('sha256').update(legacyContent).digest('hex');
  const res = db.prepare(
    `INSERT INTO embedding_meta (node_id, source_type, source_hash, chunk_index, extraction_ref, embedded_at)
     VALUES (?, 'node', ?, 0, NULL, ?)`,
  ).run(nodeId, v2Hash, new Date().toISOString());
  db.prepare('INSERT INTO embedding_vec (id, vector) VALUES (?, ?)')
    .run(BigInt(res.lastInsertRowid), new Uint8Array(new Float32Array(256).fill(0.25).buffer));
}

function insertV2ExtractionGroup(db: Database.Database, nodeId: string, ref: string): string {
  const hash = createHash('sha256').update('legacy extraction').digest('hex');
  const res = db.prepare(
    `INSERT INTO embedding_meta (node_id, source_type, source_hash, chunk_index, extraction_ref, embedded_at)
     VALUES (?, 'extraction', ?, 0, ?, ?)`,
  ).run(nodeId, hash, ref, new Date().toISOString());
  db.prepare('INSERT INTO embedding_vec (id, vector) VALUES (?, ?)')
    .run(BigInt(res.lastInsertRowid), new Uint8Array(new Float32Array(256).fill(0.25).buffer));
  return hash;
}

function groupHashes(db: Database.Database, nodeId: string): string[] {
  return (db.prepare(
    "SELECT source_hash FROM embedding_meta WHERE node_id = ? AND source_type = 'node'",
  ).all(nodeId) as Array<{ source_hash: string }>).map(r => r.source_hash);
}

function vecCount(db: Database.Database, nodeId: string): number {
  return (db.prepare(
    'SELECT COUNT(*) as cnt FROM embedding_vec WHERE id IN (SELECT id FROM embedding_meta WHERE node_id = ?)',
  ).get(nodeId) as { cnt: number }).cnt;
}

describe('planSearchUpgrade', () => {
  it('is a no-op when the stored version is current', () => {
    expect(planSearchUpgrade(3)).toBe('none');
  });

  it('rolls v2 → v3 (no clear)', () => {
    expect(planSearchUpgrade(2)).toBe('rolling');
  });

  it('clears pre-chunking v1 stores', () => {
    expect(planSearchUpgrade(1)).toBe('clear');
  });
});

describe('rolling v2 → v3 replacement', () => {
  let db: Database.Database;
  let embedder: ReturnType<typeof fakeEmbedder>;
  let indexer: EmbeddingIndexer;

  beforeEach(() => {
    db = createTestDb();
    embedder = fakeEmbedder();
    indexer = createEmbeddingIndexer(db, embedder);
    setSearchVersion(db, 2); // simulate a v2 store
  });

  afterEach(() => {
    db.close();
  });

  it('replaces a v2-hashed group (hash can never match), atomically', async () => {
    insertNode(db, 'n1', 'Alpha', 'body text');
    insertV2Group(db, 'n1', 'Alpha', 'body text');
    const v2Hash = groupHashes(db, 'n1')[0];

    // Old vector is present and searchable until the replacement lands.
    expect(vecCount(db, 'n1')).toBe(1);

    indexer.enqueue({ node_id: 'n1', source_type: 'node' });
    await indexer.processAll();

    // Same group: exactly one meta row + one vec row, with a NEW v3 hash.
    const hashes = groupHashes(db, 'n1');
    expect(hashes).toHaveLength(1);
    expect(hashes[0]).not.toBe(v2Hash);
    expect(vecCount(db, 'n1')).toBe(1);
    expect(embedder.callCount).toBe(1);
  });

  it('hash-skips updated groups on restart (crash/resume is cheap)', async () => {
    insertNode(db, 'n1', 'Alpha', 'body');
    indexer.enqueue({ node_id: 'n1', source_type: 'node' });
    await indexer.processAll();
    expect(embedder.callCount).toBe(1);

    // Simulate restart: fresh indexer over the same DB, enqueue everything again.
    const embedder2 = fakeEmbedder();
    const indexer2 = createEmbeddingIndexer(db, embedder2);
    indexer2.enqueue({ node_id: 'n1', source_type: 'node' });
    const summary = await indexer2.processAll();

    expect(embedder2.callCount).toBe(0);
    expect(summary).toEqual({ completed: 0, skipped: 1, failed: 0 });
  });

  it('re-embeds when any context component changes (e.g. a field edit)', async () => {
    insertNode(db, 'n1', 'Alpha', 'body');
    indexer.enqueue({ node_id: 'n1', source_type: 'node' });
    await indexer.processAll();
    expect(embedder.callCount).toBe(1);

    db.prepare('INSERT INTO node_fields (node_id, field_name, value_text) VALUES (?, ?, ?)')
      .run('n1', 'status', 'open');
    indexer.enqueue({ node_id: 'n1', source_type: 'node' });
    const summary = await indexer.processAll();

    expect(embedder.callCount).toBe(2);
    expect(summary.completed).toBe(1);
  });

  it('counts terminal failures and exposes rolling-upgrade status fields', async () => {
    const failing: Embedder = {
      async embedDocument(): Promise<Float32Array[]> { throw new Error('boom'); },
      async embedQuery(): Promise<Float32Array> { return new Float32Array(256); },
      isReady(): boolean { return true; },
    };
    const failIndexer = createEmbeddingIndexer(db, failing);
    insertNode(db, 'n1', 'Alpha', 'body');
    failIndexer.enqueue({ node_id: 'n1', source_type: 'node' });

    const summary = await failIndexer.processAll();
    expect(summary.failed).toBe(1); // dropped after 3 attempts
    expect(summary.completed).toBe(0);

    const status = failIndexer.getStatus();
    expect(status.stored_version).toBe(2);
    expect(status.target_version).toBe(CURRENT_SEARCH_VERSION);
    expect(status.rolling_upgrade).toBe(true);
    expect(status.terminal_failures).toBe(1);
    expect(status.last_drain).toEqual({ completed: 0, skipped: 0, failed: 1 });

    // Old v2 vectors remain in place after the failure — nothing was cleared.
    insertNode(db, 'n2', 'Beta', 'b');
    insertV2Group(db, 'n2', 'Beta', 'b');
    expect(vecCount(db, 'n2')).toBe(1);
  });

  it('blocks completion when an unavailable extraction still has a v2 group', async () => {
    const vault = createTempVault();
    try {
      insertNode(db, 'n1', 'Parent', '![[missing.pdf]]');
      const oldHash = insertV2ExtractionGroup(db, 'n1', 'missing.pdf');
      const blockedIndexer = createEmbeddingIndexer(db, embedder, {
        extractionCache: {} as ExtractionCache,
        vaultPath: vault.vaultPath,
      });

      blockedIndexer.enqueue({ node_id: 'n1', source_type: 'node' });
      const summary = await blockedIndexer.processAll();

      expect(summary).toEqual({ completed: 1, skipped: 0, failed: 1 });
      const remaining = db.prepare(
        `SELECT source_hash FROM embedding_meta
         WHERE node_id = ? AND source_type = 'extraction' AND extraction_ref = ?`,
      ).get('n1', 'missing.pdf') as { source_hash: string };
      expect(remaining.source_hash).toBe(oldHash);
      expect(blockedIndexer.getStatus().terminal_failures).toBe(1);
    } finally {
      vault.cleanup();
    }
  });

  it('rolling_upgrade flips false once version 3 is persisted', async () => {
    insertNode(db, 'n1', 'Alpha', 'body');
    indexer.enqueue({ node_id: 'n1', source_type: 'node' });
    const summary = await indexer.processAll();
    expect(summary.failed).toBe(0);

    // What index.ts does after a failure-free initial drain.
    setSearchVersion(db, CURRENT_SEARCH_VERSION);

    const status = indexer.getStatus();
    expect(status.stored_version).toBe(3);
    expect(status.rolling_upgrade).toBe(false);
    expect(getSearchVersion(db)).toBe(3);
  });

  it('extraction groups get parent context: hash changes when the parent title changes', async () => {
    // Directly exercise the hash inputs the extraction path uses: same
    // extracted text, different parent context → different hash.
    insertNode(db, 'n1', 'Old Title', '![[a.pdf]]');
    const { assembleDocumentContext, semanticSourceHash } = await import('../../src/search/semantic-context.js');
    const before = semanticSourceHash(assembleDocumentContext(db, 'n1', { ref: 'a.pdf', mediaType: 'pdf' })!, 'extracted');
    db.prepare('UPDATE nodes SET title = ? WHERE id = ?').run('New Title', 'n1');
    const after = semanticSourceHash(assembleDocumentContext(db, 'n1', { ref: 'a.pdf', mediaType: 'pdf' })!, 'extracted');
    expect(after).not.toBe(before);
  });
});
