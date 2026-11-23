import { describe, it, expect, beforeEach, onTestFinished } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createTestDb } from '../helpers/db.js';
import { upgradeForAttachmentTranscripts, upgradeForMaterializedTranscripts, upgradeForArchiveLog } from '../../src/db/migrate.js';
import { TranscriptStore } from '../../src/extraction/transcript-store.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { registerArchiveSource } from '../../src/mcp/tools/archive-source.js';
import type { EmbeddingIndexer } from '../../src/search/indexer.js';
import type { EmbeddingQueueItem } from '../../src/search/types.js';
import { setStoredSettings } from '../../src/settings/store.js';
import { TRANSCRIPTS_OFF_MESSAGE } from '../../src/mcp/tools/materialize-transcript.js';

let db: Database.Database;
let dir: string;
let store: TranscriptStore;

function parseResult(result: { content: Array<{ type: string; text: string }> }): any {
  return JSON.parse(result.content[0].text);
}

function getHandler(embeddingIndexer?: EmbeddingIndexer): (params: Record<string, unknown>) => Promise<any> {
  let captured: (params: Record<string, unknown>) => Promise<any>;
  const fakeServer = {
    tool: (_name: string, _desc: string, _schema: unknown, handler: (...args: unknown[]) => unknown) => {
      captured = (params) => Promise.resolve(handler(params)) as Promise<any>;
    },
  } as unknown as McpServer;
  registerArchiveSource(fakeServer, db, new WriteLockManager(), dir, store, undefined, undefined, embeddingIndexer);
  return captured!;
}

function recordingIndexer(): { indexer: EmbeddingIndexer; enqueued: EmbeddingQueueItem[] } {
  const enqueued: EmbeddingQueueItem[] = [];
  const indexer = {
    enqueue: (item: EmbeddingQueueItem) => { enqueued.push(item); },
  } as unknown as EmbeddingIndexer;
  return { indexer, enqueued };
}

beforeEach(() => {
  db = createTestDb();
  upgradeForAttachmentTranscripts(db);
  upgradeForMaterializedTranscripts(db);
  upgradeForArchiveLog(db);
  dir = mkdtempSync(join(tmpdir(), 've-archive-mcp-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'Attachments'), { recursive: true });
  store = new TranscriptStore(db);
  const content = 'audio-bytes';
  writeFileSync(join(dir, 'Attachments/rec.m4a'), content);
  store.capture({
    embedRef: 'rec.m4a',
    vaultPath: 'Attachments/rec.m4a',
    contentHash: createHash('sha256').update(content).digest('hex'),
    extractedText: 'a transcript',
    mediaType: 'audio',
    extractorId: 'deepgram',
  });
});

describe('archive-source envelope', () => {
  it('INVALID_PARAMS when both single keys are given', async () => {
    const body = parseResult(await getHandler()({ embed_ref: 'rec.m4a', vault_path: 'Attachments/rec.m4a' }));
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_PARAMS');
  });

  it('INVALID_PARAMS when sweep is combined with a single key', async () => {
    const body = parseResult(await getHandler()({ vault_path: 'Attachments/rec.m4a', sweep: {} }));
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_PARAMS');
  });

  it('NOT_ELIGIBLE carries details.reasons', async () => {
    writeFileSync(join(dir, 'Attachments/raw.m4a'), 'x');
    const body = parseResult(await getHandler()({ vault_path: 'Attachments/raw.m4a' }));
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('NOT_ELIGIBLE');
    expect(body.error.details.reasons).toEqual(['no_transcript']);
  });

  it('CONFIRMATION_REQUIRED for purge without confirm', async () => {
    const body = parseResult(await getHandler()({ vault_path: 'Attachments/rec.m4a', purge: true }));
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('CONFIRMATION_REQUIRED');
  });

  it('sweep defaults to dry_run:true (no disk effect)', async () => {
    const body = parseResult(await getHandler()({ sweep: {} }));
    expect(body.ok).toBe(true);
    expect(body.data.dry_run).toBe(true);
    expect(existsSync(join(dir, 'Attachments/rec.m4a'))).toBe(true);
  });

  it('single mode defaults to dry_run:false and surfaces EMBEDDINGS_UNVERIFIED in warnings', async () => {
    const body = parseResult(await getHandler()({ vault_path: 'Attachments/rec.m4a', materialize: false }));
    expect(body.ok).toBe(true);
    expect(body.data.archived.vault_path).toBe('Attachments/rec.m4a');
    expect(body.warnings.map((w: any) => w.code)).toContain('EMBEDDINGS_UNVERIFIED');
    expect(existsSync(join(dir, 'Attachments/rec.m4a'))).toBe(false);
  });

  it('purge dry-run needs no confirm and touches nothing', async () => {
    const body = parseResult(await getHandler()({ vault_path: 'Attachments/rec.m4a', purge: true, dry_run: true }));
    expect(body.ok).toBe(true);
    expect(body.data.dry_run).toBe(true);
    expect(body.data.would_archive.mode).toBe('purge');
    expect(body.data.would_archive.archive_path).toBeNull();
    expect(existsSync(join(dir, 'Attachments/rec.m4a'))).toBe(true);
  });
});

describe('archive-source and the vault map\'s transcript kind', () => {
  it('materializes into the configured kind and folder, and renders that kind\'s schema', async () => {
    setStoredSettings(db, 'vault', { transcriptType: 'recording', transcriptDir: 'Audio/Text' });
    const body = parseResult(await getHandler()({ vault_path: 'Attachments/rec.m4a' }));
    expect(body.ok).toBe(true);
    const nodeId = body.data.archived.materialized_node_id;
    expect(db.prepare('SELECT file_path FROM nodes WHERE id = ?').get(nodeId)).toEqual({ file_path: 'Audio/Text/rec.md' });
    expect(db.prepare('SELECT schema_type FROM node_types WHERE node_id = ?').all(nodeId)).toEqual([{ schema_type: 'recording' }]);
    expect(existsSync(join(dir, '.schemas/recording.yaml'))).toBe(true);
  });

  it('with the kind none, archives without a transcript note by default', async () => {
    setStoredSettings(db, 'vault', { transcriptType: null });
    const preview = parseResult(await getHandler()({ vault_path: 'Attachments/rec.m4a', dry_run: true }));
    expect(preview.ok).toBe(true);
    expect(preview.data.would_materialize).toBe(false);

    const body = parseResult(await getHandler()({ vault_path: 'Attachments/rec.m4a' }));
    expect(body.ok).toBe(true);
    expect(body.data.archived.materialized_node_id).toBeNull();
    expect(existsSync(join(dir, 'Attachments/rec.m4a'))).toBe(false);
    expect(db.prepare('SELECT COUNT(*) c FROM nodes').get()).toEqual({ c: 0 });
  });

  it('with the kind none, refuses an explicit materialize and leaves the file', async () => {
    setStoredSettings(db, 'vault', { transcriptType: null });
    for (const dry_run of [true, false]) {
      const body = parseResult(await getHandler()({ vault_path: 'Attachments/rec.m4a', materialize: true, dry_run }));
      expect(body.ok).toBe(false);
      expect(body.error).toMatchObject({ code: 'INVALID_PARAMS', message: TRANSCRIPTS_OFF_MESSAGE });
    }
    expect(existsSync(join(dir, 'Attachments/rec.m4a'))).toBe(true);
  });
});

describe('archive-source embedding enqueue (T0.3)', () => {
  it('enqueues the transcript node it materializes — tool writes skip the watcher', async () => {
    const { indexer, enqueued } = recordingIndexer();
    const body = parseResult(await getHandler(indexer)({ vault_path: 'Attachments/rec.m4a' }));

    expect(body.ok).toBe(true);
    const nodeId = body.data.archived.materialized_node_id;
    expect(nodeId).toBeTruthy();
    // Without this the node is only embedded by the next startup bulk pass —
    // the whole point of materializing is that it becomes searchable now.
    expect(enqueued).toEqual([{ node_id: nodeId, source_type: 'node' }]);
  });

  it('enqueues every node a sweep materializes, not just the first', async () => {
    const content = 'more-audio-bytes';
    writeFileSync(join(dir, 'Attachments/rec2.m4a'), content);
    store.capture({
      embedRef: 'rec2.m4a',
      vaultPath: 'Attachments/rec2.m4a',
      contentHash: createHash('sha256').update(content).digest('hex'),
      extractedText: 'a second transcript',
      mediaType: 'audio',
      extractorId: 'deepgram',
    });

    const { indexer, enqueued } = recordingIndexer();
    const body = parseResult(await getHandler(indexer)({
      sweep: { min_age_days: 0 }, dry_run: false,
    }));

    expect(body.ok).toBe(true);
    const ids = (body.data.archived as Array<{ materialized_node_id: string | null }>)
      .map((a) => a.materialized_node_id)
      .filter((id): id is string => id !== null);
    expect(ids).toHaveLength(2);
    expect(enqueued.map((e) => e.node_id).sort()).toEqual([...ids].sort());
  });

  it('enqueues nothing on a dry run', async () => {
    const { indexer, enqueued } = recordingIndexer();
    const body = parseResult(await getHandler(indexer)({
      vault_path: 'Attachments/rec.m4a', dry_run: true,
    }));

    expect(body.ok).toBe(true);
    expect(enqueued).toEqual([]);
  });

  it('archives fine with no indexer wired (stdio/test contexts)', async () => {
    const body = parseResult(await getHandler()({ vault_path: 'Attachments/rec.m4a' }));
    expect(body.ok).toBe(true);
  });
});
