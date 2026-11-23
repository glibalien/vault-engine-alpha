import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createSchema } from '../../src/db/schema.js';
import { addUndoTables, addUiHints } from '../../src/db/migrate.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { executeRename } from '../../src/mcp/tools/rename-node.js';
import { describePipelineError } from '../../src/mcp/tools/errors.js';
import { PipelineError } from '../../src/pipeline/types.js';

let db: Database.Database;
let dir: string;

beforeEach(() => {
  db = new Database(':memory:');
  createSchema(db);
  addUndoTables(db);
  addUiHints(db);
  dir = mkdtempSync(join(tmpdir(), 've-rename-val-'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('rename-node validation-failure mapping', () => {
  it('maps a PRIMARY-node re-render PipelineError to VALIDATION_FAILED', () => {
    createGlobalField(db, { name: 'priority', field_type: 'string', required: true });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'priority' }] });

    // A 'task' node missing its required field; renaming forces a re-render that throws.
    writeFileSync(join(dir, 'Old.md'), '# Old');
    db.prepare('INSERT INTO nodes (id, file_path, title, body, content_hash, version) VALUES (?, ?, ?, ?, ?, 1)')
      .run('t1', 'Old.md', 'Old', '', 'h');
    db.prepare('INSERT INTO node_types (node_id, schema_type, sort_order) VALUES (?, ?, ?)')
      .run('t1', 'task', 0);

    let caught: unknown;
    try {
      const txn = db.transaction(() => {
        executeRename(db, new WriteLockManager(), dir,
          { node_id: 't1', file_path: 'Old.md', title: 'Old' }, 'New', 'New.md');
      });
      txn();
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(PipelineError);
    const d = describePipelineError(caught);
    expect(d?.code).toBe('VALIDATION_FAILED');
    expect((d?.details.issues as Array<{ code: string }>).some(i => i.code === 'REQUIRED_MISSING')).toBe(true);
  });

  it('annotates node_file_path with the failing REFERENCING note (ref-loop path)', () => {
    createGlobalField(db, { name: 'priority', field_type: 'string', required: true });
    createSchemaDefinition(db, { name: 'task', field_claims: [{ field: 'priority' }] });

    // Primary node to rename — type-less so its own re-render is valid.
    writeFileSync(join(dir, 'Target.md'), '# Target');
    db.prepare('INSERT INTO nodes (id, file_path, title, body, content_hash, version) VALUES (?, ?, ?, ?, ?, 1)')
      .run('tgt', 'Target.md', 'Target', '', 'h1');

    // A 'task' note (missing required field) that links to the primary via [[Target]].
    writeFileSync(join(dir, 'RefNote.md'), '# RefNote');
    db.prepare('INSERT INTO nodes (id, file_path, title, body, content_hash, version) VALUES (?, ?, ?, ?, ?, 1)')
      .run('ref1', 'RefNote.md', 'RefNote', 'See [[Target]] for context.', 'h2');
    db.prepare('INSERT INTO node_types (node_id, schema_type, sort_order) VALUES (?, ?, ?)')
      .run('ref1', 'task', 0);
    // resolved_target_id mirrors what executeMutation stores at insert time
    // (resolveTarget('Target') === 'tgt'); rename-node discovers referencing
    // notes via this precomputed column, not a query-time resolver pass.
    db.prepare('INSERT INTO relationships (source_id, target, rel_type, context, resolved_target_id) VALUES (?, ?, ?, ?, ?)')
      .run('ref1', 'Target', 'wiki-link', 'ctx', 'tgt');

    let caught: unknown;
    try {
      const txn = db.transaction(() => {
        executeRename(db, new WriteLockManager(), dir,
          { node_id: 'tgt', file_path: 'Target.md', title: 'Target' }, 'NewTarget', 'NewTarget.md');
      });
      txn();
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(PipelineError);
    const d = describePipelineError(caught);
    expect(d?.code).toBe('VALIDATION_FAILED');
    expect(d?.details.node_file_path).toBe('RefNote.md');
    expect((d?.details.issues as Array<{ code: string }>).some(i => i.code === 'REQUIRED_MISSING')).toBe(true);
  });
});
