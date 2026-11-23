import { existsSync, readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { join } from 'node:path';
import { createTestDb } from './db.js';
import { createTempVault } from './vault.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';

export interface ReferenceEditFixture {
  db: Database.Database; vaultPath: string; writeLock: WriteLockManager;
  taskId: string; projectIds: string[];
  cleanup(): void;
  snapshot(): { file: string | null; tables: Record<string, unknown[]> };
  source(): { version: number; content_hash: string };
  members(): string[] | undefined;
}

export function referenceEditFixture(fields: Record<string, unknown> = { project: ['P1'] }, options: { verbose?: (message?: unknown) => void } = {}): ReferenceEditFixture {
  const db: Database.Database = createTestDb(options);
  const vault = createTempVault();
  const writeLock = new WriteLockManager();
  createGlobalField(db, { name: 'project', field_type: 'list', list_item_type: 'reference', reference_target: 'Project' });
  createGlobalField(db, { name: 'note', field_type: 'string' });
  createSchemaDefinition(db, { name: 'Project', field_claims: [] });
  createSchemaDefinition(db, { name: 'Task', field_claims: [{ field: 'project' }, { field: 'note' }] });
  const projectIds = ['P1', 'P2', 'P3'].map(title => executeMutation(db, writeLock, vault.vaultPath, {
    source: 'tool', node_id: null, file_path: `Projects/${title}.md`, title, types: ['Project'], fields: {}, body: '',
  }).node_id);
  const taskId = executeMutation(db, writeLock, vault.vaultPath, {
    source: 'undo', node_id: null, file_path: 'Task.md', title: 'Task', types: ['Task'], fields, body: 'Body [[P3]]',
    explicitNullFields: Object.keys(fields).filter(field => fields[field] === null),
  }).node_id;
  return {
    db, vaultPath: vault.vaultPath, writeLock, taskId, projectIds,
    cleanup: () => { writeLock.clearRecentWrites(); db.close(); vault.cleanup(); },
    snapshot: () => ({
      file: existsSync(join(vault.vaultPath, 'Task.md')) ? readFileSync(join(vault.vaultPath, 'Task.md'), 'utf8') : null,
      tables: Object.fromEntries(['nodes', 'node_fields', 'node_types', 'node_explicit_null_fields', 'relationships', 'nodes_fts', 'edits_log', 'undo_operations', 'undo_snapshots'].map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()])),
    }),
    source: () => db.prepare('SELECT version, content_hash FROM nodes WHERE id = ?').get(taskId) as { version: number; content_hash: string },
    members: () => {
      const row = db.prepare("SELECT value_json FROM node_fields WHERE node_id = ? AND field_name = 'project'").get(taskId) as { value_json: string } | undefined;
      return row ? JSON.parse(row.value_json) as string[] : undefined;
    },
  };
}
