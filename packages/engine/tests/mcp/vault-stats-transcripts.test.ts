import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTestDb } from '../helpers/db.js';
import { upgradeForAttachmentTranscripts } from '../../src/db/migrate.js';
import { registerVaultStats } from '../../src/mcp/tools/vault-stats.js';
import { TranscriptStore } from '../../src/extraction/transcript-store.js';
import type Database from 'better-sqlite3';

async function callTool(server: McpServer, name: string, args: Record<string, unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool.callback ? tool.callback(args) : tool.handler(args);
}

describe('vault-stats — transcript counts', () => {
  let db: Database.Database;
  let server: McpServer;

  beforeEach(() => {
    db = createTestDb();
    upgradeForAttachmentTranscripts(db);
    server = new McpServer({ name: 'test', version: '0' });
    registerVaultStats(server, db);
  });
  afterEach(() => { db.close(); });

  it('returns retained_transcripts and orphaned_transcripts counts', async () => {
    const store = new TranscriptStore(db);
    // Capture two transcripts
    store.capture({
      embedRef: 'file1.pdf',
      vaultPath: 'attachments/file1.pdf',
      contentHash: 'hash1',
      extractedText: 'content one',
      mediaType: 'application/pdf',
      extractorId: 'unpdf',
    });
    store.capture({
      embedRef: 'file2.pdf',
      vaultPath: 'attachments/file2.pdf',
      contentHash: 'hash2',
      extractedText: 'content two',
      mediaType: 'application/pdf',
      extractorId: 'unpdf',
    });
    // Mark the second one as deleted (orphaned)
    store.markDeleted('attachments/file2.pdf');

    const result = await callTool(server, 'vault-stats', {});
    const payload = JSON.parse(result.content[0].text);
    expect(payload.data.retained_transcripts).toBe(2);
    expect(payload.data.orphaned_transcripts).toBe(1);
  });
});

describe('vault-stats — transcript counts guard (no migration)', () => {
  let db: Database.Database;
  let server: McpServer;

  beforeEach(() => {
    // createTestDb does NOT call upgradeForAttachmentTranscripts
    db = createTestDb();
    server = new McpServer({ name: 'test', version: '0' });
    registerVaultStats(server, db);
  });
  afterEach(() => { db.close(); });

  it('returns 0 for both counts without throwing when table is absent', async () => {
    const result = await callTool(server, 'vault-stats', {});
    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.data.retained_transcripts).toBe(0);
    expect(payload.data.orphaned_transcripts).toBe(0);
  });
});
