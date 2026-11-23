// Undo keeps a note's values that fail validation (#499). Each undo kind puts a
// note back in a state where one of its values is rejected by the definition in
// force: the value stays in the file and the database, and a re-index of the
// file keeps it. Notes the operation never touched keep their bytes.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { registerAllTools } from '../../src/mcp/tools/index.js';
import { createGlobalField, getGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { renderFieldsFile, renderSchemaFile } from '../../src/schema/render.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { SyncLogger } from '../../src/sync/sync-logger.js';
import { processFileChange } from '../../src/sync/watcher.js';

async function callTool(server: McpServer, name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool.callback ? tool.callback(args) : tool.handler(args);
}

function payload(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

// A task note as Engine renders it, so a restore gives back the same bytes.
const NOTE_A = '---\ntypes:\n  - task\nstatus: open\npriority: urgent\nsize: 3\n---\nBody A\n';
// A note no operation below touches.
const NOTE_B = '---\npriority: urgent\nnote: kept as typed\n---\nBody B\n';

describe('undo keeps values that fail validation (#499)', () => {
  let vaultPath: string;
  let cleanup: () => void;
  let db: Database.Database;
  let writeLock: WriteLockManager;
  let server: McpServer;

  beforeEach(() => {
    const v = createTempVault();
    vaultPath = v.vaultPath;
    cleanup = v.cleanup;
    db = createTestDb();
    writeLock = new WriteLockManager();
    server = new McpServer({ name: 'test', version: '0' });
    registerAllTools(server, db, { writeLock, vaultPath, syncLogger: new SyncLogger(db) });
    createGlobalField(db, { name: 'status', field_type: 'enum', enum_values: ['open', 'closed', 'waiting'] });
    createGlobalField(db, { name: 'priority', field_type: 'enum', enum_values: ['low', 'high', 'urgent'] });
    createGlobalField(db, { name: 'size', field_type: 'number' });
    createSchemaDefinition(db, {
      name: 'task',
      field_claims: [
        { field: 'status', sort_order: 1 },
        { field: 'priority', sort_order: 2 },
        { field: 'size', sort_order: 3 },
      ],
    });
    renderFieldsFile(db, vaultPath);
    renderSchemaFile(db, vaultPath, 'task');
    writeNote('a.md', NOTE_A);
    writeNote('b.md', NOTE_B);
  });

  afterEach(() => {
    db.close();
    cleanup();
  });

  function writeNote(relPath: string, content: string): void {
    writeFileSync(join(vaultPath, relPath), content, 'utf-8');
    reindex(relPath);
  }

  function reindex(relPath: string): void {
    processFileChange(join(vaultPath, relPath), relPath, db, writeLock, vaultPath);
  }

  function read(relPath: string): string {
    return readFileSync(join(vaultPath, relPath), 'utf-8');
  }

  function values(relPath: string): Record<string, unknown> {
    const rows = db.prepare(`
      SELECT f.field_name, f.value_text, f.value_number
      FROM node_fields f JOIN nodes n ON n.id = f.node_id
      WHERE n.file_path = ?
      ORDER BY f.field_name
    `).all(relPath) as Array<{ field_name: string; value_text: string | null; value_number: number | null }>;
    return Object.fromEntries(rows.map(r => [r.field_name, r.value_text ?? r.value_number]));
  }

  function rejectedRecords(): Array<Record<string, unknown>> {
    return (db.prepare(`SELECT details FROM edits_log WHERE event_type = 'value-rejected' ORDER BY id`).all() as Array<{ details: string }>)
      .map(row => JSON.parse(row.details) as Record<string, unknown>);
  }

  async function ok(name: string, args: Record<string, unknown>) {
    const result = payload(await callTool(server, name, args));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    return result.data;
  }

  function latestOperation(sourceTool: string): string {
    return (db.prepare(
      'SELECT operation_id FROM undo_operations WHERE source_tool = ? ORDER BY timestamp DESC, rowid DESC LIMIT 1',
    ).get(sourceTool) as { operation_id: string }).operation_id;
  }

  async function undo(operationId: string): Promise<void> {
    await ok('undo-operations', { operation_ids: [operationId], dry_run: false });
  }

  /** The note keeps the value in its file and in the database, also after a re-index of the file. */
  function expectKept(relPath: string, content: string, expected: Record<string, unknown>): void {
    expect(read(relPath)).toBe(content);
    expect(values(relPath)).toEqual(expected);
    reindex(relPath);
    expect(values(relPath)).toEqual(expected);
  }

  // `priority: urgent` was valid when the operation ran. Narrowing the enum afterwards
  // keeps it in the note (no re-render), but the definition in force now rejects it.
  async function narrowPriority(): Promise<void> {
    await ok('update-global-field', { name: 'priority', enum_values: ['low', 'high'] });
  }

  describe('global-field undo rewrites the notes its snapshot recorded', () => {
    it.each([
      { op: 'update', tool: 'update-global-field', args: { name: 'status', description: 'Changed' } },
      { op: 'rename', tool: 'rename-global-field', args: { old_name: 'status', new_name: 'state' } },
      { op: 'delete', tool: 'delete-global-field', args: { name: 'status' } },
    ])('$op undo keeps a value of another field that the definition now rejects', async ({ tool, args }) => {
      await ok(tool, args);
      const operationId = latestOperation(tool);
      await narrowPriority();

      await undo(operationId);

      expect(getGlobalField(db, 'status')?.enum_values).toEqual(['open', 'closed', 'waiting']);
      expectKept('a.md', NOTE_A, { priority: 'urgent', size: 3, status: 'open' });
      expectKept('b.md', NOTE_B, { note: 'kept as typed', priority: 'urgent' });
    });

    it.each([
      { op: 'update', tool: 'update-global-field', args: { name: 'status', enum_values: ['open', 'closed', 'waiting'] } },
      { op: 'delete', tool: 'delete-global-field', args: { name: 'status' } },
    ])('$op undo keeps the recorded value that the restored definition rejects', async ({ tool, args }) => {
      const waiting = NOTE_A.replace('status: open', 'status: waiting');
      writeNote('a.md', waiting);
      // `waiting` stays in the note when the enum narrows, now rejected.
      await ok('update-global-field', { name: 'status', enum_values: ['open', 'closed'] });

      await ok(tool, args);
      await undo(latestOperation(tool));

      expect(getGlobalField(db, 'status')?.enum_values).toEqual(['open', 'closed']);
      expectKept('a.md', waiting, { priority: 'urgent', size: 3, status: 'waiting' });
      expect(read('b.md')).toBe(NOTE_B);
    });
  });

  describe('schema undo restores the notes its propagation rewrote', () => {
    it('keeps a value that the restored claim rejects', async () => {
      await narrowPriority();
      // Unclaimed, priority moves after size: propagation rewrites the note and records it.
      const update = await ok('update-schema', { name: 'task', remove_field_claims: ['priority'], confirm_large_change: true });
      expect(update.propagation.nodes_rerendered).toBe(1);
      expect(read('a.md')).toBe('---\ntypes:\n  - task\nstatus: open\nsize: 3\npriority: urgent\n---\nBody A\n');

      await undo(update.operation_id);

      expect(db.prepare(`SELECT 1 FROM schema_field_claims WHERE schema_name = 'task' AND field = 'priority'`).get()).toBeDefined();
      expectKept('a.md', NOTE_A, { priority: 'urgent', size: 3, status: 'open' });
      expect(read('b.md')).toBe(NOTE_B);
      expect(rejectedRecords()).toEqual([
        expect.objectContaining({ source: 'undo', field: 'priority', rejected_value: 'urgent', retained_value: 'urgent', reason_code: 'ENUM_MISMATCH' }),
      ]);
    });
  });

  describe('node undo restores the note it recorded', () => {
    it('delete-node undo brings back a note holding a value its definition rejects', async () => {
      await narrowPriority();
      await ok('delete-node', { file_path: 'a.md', confirm: true, referencing_nodes_limit: 20 });

      await undo(latestOperation('delete-node'));

      expectKept('a.md', NOTE_A, { priority: 'urgent', size: 3, status: 'open' });
      expect(read('b.md')).toBe(NOTE_B);
      expect(rejectedRecords()).toEqual([
        expect.objectContaining({ source: 'undo', field: 'priority', retained_value: 'urgent', reason_code: 'ENUM_MISMATCH' }),
      ]);
    });

    it('update-node undo restores a value the definition rejected after the update', async () => {
      await ok('update-node', { file_path: 'a.md', set_body: 'Edited' });
      await narrowPriority();

      await undo(latestOperation('update-node'));

      expectKept('a.md', NOTE_A, { priority: 'urgent', size: 3, status: 'open' });
      expect(read('b.md')).toBe(NOTE_B);
    });

    it('a reverted conflict restores a value of a type the definition no longer accepts', async () => {
      await ok('update-node', { file_path: 'a.md', set_body: 'Edited' });
      // The type change discards the number and rewrites the note.
      await ok('update-global-field', { name: 'size', field_type: 'boolean', confirm: true, discard_uncoercible: true });
      const nodeId = (db.prepare(`SELECT id FROM nodes WHERE file_path = 'a.md'`).get() as { id: string }).id;

      await ok('undo-operations', {
        operation_ids: [latestOperation('update-node')],
        dry_run: false,
        resolve_conflicts: [{ node_id: nodeId, action: 'revert' }],
      });

      expect(getGlobalField(db, 'size')?.field_type).toBe('boolean');
      expectKept('a.md', NOTE_A, { priority: 'urgent', size: 3, status: 'open' });
      expect(rejectedRecords()).toEqual([
        expect.objectContaining({ source: 'undo', field: 'size', retained_value: 3, reason_code: 'TYPE_MISMATCH' }),
      ]);
    });
  });
});
