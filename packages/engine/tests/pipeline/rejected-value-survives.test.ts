// A value typed into a note that fails validation survives later Engine writes (#501).
//
// The watcher keeps such a value out of the database (or keeps the value the database
// already held) and logs `value-rejected`. Every later write renders the note from the
// database, so before #501 the typed text left the file at the next write. Each test
// below types a value into a note's file, lets the real watcher ingest take it, then runs
// a real Engine write, and checks the typed line is still in the file byte for byte and
// the database still holds what the watcher left.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { registerAllTools } from '../../src/mcp/tools/index.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { renderFieldsFile, renderSchemaFile } from '../../src/schema/render.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { SyncLogger } from '../../src/sync/sync-logger.js';
import { processFileChange } from '../../src/sync/watcher.js';
import { runNormalizerSweep } from '../../src/sync/normalizer.js';
import { executeMutation, resaveWithCanonicalLinks } from '../../src/pipeline/execute.js';
import { fullIndex } from '../../src/indexer/indexer.js';
import { sha256 } from '../../src/indexer/hash.js';

async function callTool(server: McpServer, name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool.callback ? tool.callback(args) : tool.handler(args);
}

function payload(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

const task = (lines: string, body = 'Body\n') => `---\ntypes:\n  - task\n${lines}---\n${body}`;

describe('a typed value that fails validation survives later writes (#501)', () => {
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
    createGlobalField(db, { name: 'status', field_type: 'enum', enum_values: ['open', 'closed'], overrides_allowed: { enum_values: true } });
    createGlobalField(db, { name: 'size', field_type: 'number' });
    createGlobalField(db, { name: 'due', field_type: 'date' });
    createGlobalField(db, { name: 'done', field_type: 'boolean' });
    createGlobalField(db, { name: 'scores', field_type: 'list', list_item_type: 'number' });
    createGlobalField(db, { name: 'owner', field_type: 'reference' });
    createGlobalField(db, { name: 'severity', field_type: 'enum', enum_values: ['low', 'high'], required: true, default_value: 'low' });
    createGlobalField(db, { name: 'code', field_type: 'enum', enum_values: ['a', 'b'], required: true });
    createGlobalField(db, { name: 'label', field_type: 'string' });
    createGlobalField(db, { name: 'assignee', field_type: 'reference', reference_target: 'ticket' });
    createSchemaDefinition(db, {
      name: 'task',
      field_claims: [
        { field: 'status', sort_order: 1 },
        { field: 'size', sort_order: 2 },
        { field: 'due', sort_order: 3 },
        { field: 'done', sort_order: 4 },
        { field: 'scores', sort_order: 5 },
        { field: 'owner', sort_order: 6 },
        { field: 'assignee', sort_order: 7 },
      ],
    });
    createSchemaDefinition(db, {
      name: 'project',
      field_claims: [{ field: 'status', sort_order: 1, enum_values_override: ['planned', 'active'] }],
    });
    createSchemaDefinition(db, {
      name: 'ticket',
      field_claims: [{ field: 'severity', sort_order: 1 }, { field: 'code', sort_order: 2 }],
    });
    renderFieldsFile(db, vaultPath);
    for (const schema of ['task', 'project', 'ticket']) renderSchemaFile(db, vaultPath, schema);
  });

  afterEach(() => {
    db.close();
    cleanup();
  });

  /** Save a note as a person would, then let the watcher ingest it. */
  function type(relPath: string, content: string): void {
    writeFileSync(join(vaultPath, relPath), content, 'utf-8');
    processFileChange(join(vaultPath, relPath), relPath, db, writeLock, vaultPath);
  }

  function read(relPath: string): string {
    return readFileSync(join(vaultPath, relPath), 'utf-8');
  }

  function stored(relPath: string): Record<string, unknown> {
    const rows = db.prepare(`
      SELECT f.field_name, f.value_text, f.value_number, f.value_date, f.value_json
      FROM node_fields f JOIN nodes n ON n.id = f.node_id
      WHERE n.file_path = ?
      ORDER BY f.field_name
    `).all(relPath) as Array<{ field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null }>;
    return Object.fromEntries(rows.map(r => [r.field_name,
      r.value_json !== null ? JSON.parse(r.value_json) : r.value_text ?? r.value_number ?? r.value_date]));
  }

  function rejected(field: string): Array<Record<string, unknown>> {
    return (db.prepare(`SELECT details FROM edits_log WHERE event_type = 'value-rejected' ORDER BY id`).all() as Array<{ details: string }>)
      .map(row => JSON.parse(row.details) as Record<string, unknown>)
      .filter(details => details.field === field);
  }

  function nodeId(relPath: string): string {
    return (db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(relPath) as { id: string }).id;
  }

  async function call(name: string, args: Record<string, unknown>) {
    return payload(await callTool(server, name, args));
  }

  async function ok(name: string, args: Record<string, unknown>) {
    const result = await call(name, args);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    return result.data;
  }

  describe('a field the database held no value for', () => {
    it('keeps an enum value outside the list through a body edit', async () => {
      type('a.md', task('status: bogus\n'));
      expect(stored('a.md')).toEqual({});
      expect(rejected('status')).toMatchObject([{ source: 'watcher', rejected_value: 'bogus', retained_value: null, reason_code: 'ENUM_MISMATCH' }]);

      await ok('update-node', { file_path: 'a.md', set_body: 'Edited\n' });

      expect(read('a.md')).toBe(task('status: bogus\n', 'Edited\n'));
      expect(stored('a.md')).toEqual({});
      // The tool's file is the one the database records: the watcher reads nothing new.
      expect((db.prepare('SELECT content_hash FROM nodes WHERE file_path = ?').get('a.md') as { content_hash: string }).content_hash)
        .toBe(sha256(read('a.md')));
    });

    it.each([
      ['an uncoercible number', 'size: lots\n', 'TYPE_MISMATCH'],
      ['an uncoercible date', 'due: not a date at all\n', 'TYPE_MISMATCH'],
      ['an uncoercible boolean', 'done: maybe\n', 'TYPE_MISMATCH'],
      ['a list item of the wrong type (flow list)', 'scores: [1, two,  3]\n', 'LIST_ITEM_COERCION_FAILED'],
      ['a list item of the wrong type (block list)', 'scores:\n  - 1\n  - two\n', 'LIST_ITEM_COERCION_FAILED'],
      ['a reference that is not a name', 'owner: 42\n', 'TYPE_MISMATCH'],
      ['a quoted enum value with a comment', 'status: "Bogus value"  # typed by hand\n', 'ENUM_MISMATCH'],
    ])('keeps %s as typed', async (_label, line, reasonCode) => {
      const field = line.slice(0, line.indexOf(':'));
      type('a.md', task(line));
      expect(stored('a.md')).toEqual({});
      expect(rejected(field)).toMatchObject([{ retained_value: null, reason_code: reasonCode }]);

      await ok('update-node', { file_path: 'a.md', set_body: 'Edited\n' });

      expect(read('a.md')).toBe(task(line, 'Edited\n'));
      expect(stored('a.md')).toEqual({});
    });

    it('keeps the typed value among valid fields, in schema order, while valid fields are written as before', async () => {
      type('a.md', task('owner: "[[Someone]]"\nstatus: bogus\nsize: 3\nnote: free text\n'));
      expect(stored('a.md')).toEqual({ owner: 'Someone', size: 3, note: 'free text' });

      await ok('update-node', { file_path: 'a.md', set_body: 'Edited\n' });

      expect(read('a.md')).toBe(task('status: bogus\nsize: 3\nowner: "[[Someone]]"\nnote: free text\n', 'Edited\n'));
      expect(stored('a.md')).toEqual({ owner: 'Someone', size: 3, note: 'free text' });
    });
  });

  describe('the file as the watcher read it', () => {
    it('keeps typed text from a CRLF file, written with the line endings Engine writes', async () => {
      type('a.md', '---\r\ntypes:\r\n  - task\r\nscores:\r\n  - 1\r\n  - two\r\n---\r\nBody\r\n');
      expect(stored('a.md')).toEqual({});

      await ok('update-node', { file_path: 'a.md', set_body: 'Edited\n' });

      expect(read('a.md')).toBe(task('scores:\n  - 1\n  - two\n', 'Edited\n'));
    });

    it('keeps a value that fails validation typed after the watcher last read the file; a valid one is replaced as before', async () => {
      type('a.md', task('size: 2\n'));
      // Saved, but not read by the watcher yet when the tool writes.
      writeFileSync(join(vaultPath, 'a.md'), task('status: bogus\nsize: 2\ndone: true\n'), 'utf-8');

      await ok('update-node', { file_path: 'a.md', set_fields: { size: 3 } });

      // The watcher would have rejected the status and stored nothing for it, so the
      // write keeps it; the valid value it has not read is replaced, as before #501.
      expect(read('a.md')).toBe(task('status: bogus\nsize: 3\n'));
      expect(stored('a.md')).toEqual({ size: 3 });
    });
  });

  describe('a value that passes validation now, after the watcher rejected it', () => {
    beforeEach(async () => {
      type('a.md', task('status: waiting\nsize: 2\n'));
      expect(stored('a.md')).toEqual({ size: 2 });
      // Widening the enum re-renders nothing and stores nothing: the file still holds the
      // value the database does not.
      await ok('update-global-field', { name: 'status', enum_values: ['open', 'closed', 'waiting'] });
    });

    it('is kept while the file is the one the watcher read', async () => {
      await ok('update-node', { file_path: 'a.md', set_fields: { size: 3 } });
      await ok('update-node', { file_path: 'a.md', set_fields: { size: 4 } });
      expect(read('a.md')).toBe(task('status: waiting\nsize: 4\n'));
      expect(stored('a.md')).toEqual({ size: 4 });
    });

    it('is kept by a composed preview as by the writes it previews', async () => {
      const base = { source: 'tool' as const, node_id: nodeId('a.md'), file_path: 'a.md', title: 'a', types: ['task'], body: 'Body\n' };
      let previewHash = '';
      try {
        db.transaction(() => {
          const first = executeMutation(db, writeLock, vaultPath, { ...base, fields: { size: 3 }, touchedFields: ['size'], db_only: true });
          const second = executeMutation(db, writeLock, vaultPath, {
            ...base, fields: { size: 4 }, touchedFields: ['size'], db_only: true, previewDiskContentHash: first.rendered_hash,
          });
          previewHash = second.rendered_hash;
          throw new Error('roll back the preview');
        })();
      } catch (err) {
        if ((err as Error).message !== 'roll back the preview') throw err;
      }

      await ok('update-node', { file_path: 'a.md', set_fields: { size: 3 } });
      await ok('update-node', { file_path: 'a.md', set_fields: { size: 4 } });
      expect(previewHash).toBe(sha256(read('a.md')));
    });
  });

  describe('a field the database held a value for', () => {
    it('keeps the stored value and leaves the typed text in the file', async () => {
      type('a.md', task('status: open\n'));
      type('a.md', task('status: bogus\n'));
      expect(stored('a.md')).toEqual({ status: 'open' });
      expect(rejected('status')).toMatchObject([{ rejected_value: 'bogus', retained_value: 'open' }]);

      await ok('update-node', { file_path: 'a.md', set_body: 'Edited\n' });

      // Before #501 the file went back to `status: open`: the person's text was gone.
      expect(read('a.md')).toBe(task('status: bogus\n', 'Edited\n'));
      expect(stored('a.md')).toEqual({ status: 'open' });
    });
  });

  describe('per-type rules', () => {
    it('keeps a value no type of a note with several types accepts', async () => {
      const content = '---\ntypes:\n  - project\n  - task\nstatus: bogus\n---\nBody\n';
      type('a.md', content);
      expect(stored('a.md')).toEqual({});

      await ok('update-node', { file_path: 'a.md', set_body: 'Edited\n' });

      expect(read('a.md')).toBe(content.replace('Body\n', 'Edited\n'));
    });

    it('stores, and renders from the database, a value one of the types accepts', async () => {
      type('a.md', '---\ntypes:\n  - project\n  - task\nstatus: Planned\n---\nBody\n');
      expect(stored('a.md')).toEqual({ status: 'planned' });

      await ok('update-node', { file_path: 'a.md', set_body: 'Edited\n' });

      expect(read('a.md')).toBe('---\ntypes:\n  - project\n  - task\nstatus: planned\n---\nEdited\n');
    });

    it('stores a reference to a note of another type, as before: the target type is not validation', async () => {
      type('p.md', '---\ntypes:\n  - project\n---\nA project\n');
      type('a.md', task('assignee: "[[p]]"\n'));
      expect(stored('a.md')).toEqual({ assignee: 'p' });
      expect(rejected('assignee')).toEqual([]);

      await ok('update-node', { file_path: 'a.md', set_body: 'Edited\n' });

      expect(read('a.md')).toBe(task('assignee: "[[p]]"\n', 'Edited\n'));
    });

    it('keeps a rejected required value while a write fills in its default', async () => {
      type('t.md', '---\ntypes:\n  - ticket\nseverity: extreme\ncode: a\n---\nBody\n');
      expect(stored('t.md')).toEqual({ code: 'a' });

      await ok('update-node', { file_path: 't.md', set_body: 'Edited\n' });

      expect(stored('t.md')).toEqual({ code: 'a', severity: 'low' });
      expect(read('t.md')).toBe('---\ntypes:\n  - ticket\nseverity: extreme\ncode: a\n---\nEdited\n');
    });

    it('refuses a write while a required value with no default is missing, as before', async () => {
      const content = '---\ntypes:\n  - ticket\nseverity: low\ncode: zzz\n---\nBody\n';
      type('t.md', content);
      expect(stored('t.md')).toEqual({ severity: 'low' });

      const result = await call('update-node', { file_path: 't.md', set_body: 'Edited\n' });

      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('VALIDATION_FAILED');
      expect(read('t.md')).toBe(content);
    });
  });

  describe('a write that sets the field replaces the typed text', () => {
    it('with a valid value', async () => {
      type('a.md', task('status: bogus\n'));
      await ok('update-node', { file_path: 'a.md', set_fields: { status: 'closed' } });
      expect(read('a.md')).toBe(task('status: closed\n'));
      expect(stored('a.md')).toEqual({ status: 'closed' });
    });

    it('with null, which removes it', async () => {
      type('a.md', task('status: bogus\nsize: 2\n'));
      await ok('update-node', { file_path: 'a.md', set_fields: { status: null } });
      expect(read('a.md')).toBe(task('size: 2\n'));
    });

    it('in query mode', async () => {
      type('a.md', task('status: bogus\n'));
      await ok('update-node', { query: { types: ['task'] }, set_fields: { status: 'open' }, dry_run: false });
      expect(read('a.md')).toBe(task('status: open\n'));
    });

    it('in batch-mutate', async () => {
      type('a.md', task('status: bogus\n'));
      await ok('batch-mutate', { operations: [{ op: 'update', params: { file_path: 'a.md', set_fields: { status: 'open' } } }] });
      expect(read('a.md')).toBe(task('status: open\n'));
    });
  });

  describe('every later Engine write keeps the typed text', () => {
    const typed = 'status: bogus\n';

    beforeEach(() => {
      type('a.md', task(`${typed}size: 2\n`));
    });

    it('a write that sets another field', async () => {
      await ok('update-node', { file_path: 'a.md', set_fields: { size: 5 } });
      expect(read('a.md')).toBe(task(`${typed}size: 5\n`));
    });

    it('adding and removing a type', async () => {
      await ok('update-node', { file_path: 'a.md', add_types: ['project'] });
      expect(read('a.md')).toContain(typed);
      await ok('update-node', { file_path: 'a.md', remove_types: ['project', 'task'] });
      expect(read('a.md')).toContain(typed);
      expect(stored('a.md')).not.toHaveProperty('status');
    });

    it('a rename, at the new path', async () => {
      await ok('update-node', { file_path: 'a.md', set_title: 'renamed' });
      expect(existsSync(join(vaultPath, 'a.md'))).toBe(false);
      expect(read('renamed.md')).toBe(task(`${typed}size: 2\n`));
    });

    it('the link rewrite in another note when the note it links to is renamed', async () => {
      type('linker.md', task('status: nope\nowner: "[[a]]"\n', 'See [[a]]\n'));
      expect(stored('linker.md')).toEqual({ owner: 'a' });
      await ok('update-node', { file_path: 'a.md', set_title: 'renamed' });
      expect(read('linker.md')).toBe(task('status: nope\nowner: "[[renamed]]"\n', 'See [[renamed]]\n'));
      expect(stored('linker.md')).toEqual({ owner: 'renamed' });
    });

    it('a global field change and its undo', async () => {
      await ok('update-global-field', { name: 'size', field_type: 'string', confirm: true });
      expect(read('a.md')).toBe(task(`${typed}size: "2"\n`));
      const operationId = (db.prepare(
        "SELECT operation_id FROM undo_operations WHERE source_tool = 'update-global-field' ORDER BY timestamp DESC, rowid DESC LIMIT 1",
      ).get() as { operation_id: string }).operation_id;
      await ok('undo-operations', { operation_ids: [operationId], dry_run: false });
      expect(read('a.md')).toBe(task(`${typed}size: 2\n`));
    });

    it('batch-mutate updating another field', async () => {
      await ok('batch-mutate', { operations: [{ op: 'update', params: { file_path: 'a.md', set_fields: { size: 7 } } }] });
      expect(read('a.md')).toBe(task(`${typed}size: 7\n`));
    });

    it('schema propagation from a claim added, and from the claim on the field removed', async () => {
      await ok('update-schema', { name: 'task', add_field_claims: [{ field: 'label', sort_order: 9 }] });
      expect(read('a.md')).toContain(typed);
      await ok('update-schema', { name: 'task', remove_field_claims: ['status'] });
      expect(read('a.md')).toContain(typed);
      expect(stored('a.md')).toEqual({ size: 2 });
    });

    it('a link-repair re-save', () => {
      writeFileSync(join(vaultPath, 'a.md'), task(`${typed}size: 2\n`, 'See [[Other: note]]\n'), 'utf-8');
      processFileChange(join(vaultPath, 'a.md'), 'a.md', db, writeLock, vaultPath);
      type('Other- note.md', '---\ntypes:\n---\nTarget\n');
      resaveWithCanonicalLinks(db, writeLock, vaultPath, nodeId('a.md'));
      expect(read('a.md')).toBe(task(`${typed}size: 2\n`, 'See [[Other- note|Other: note]]\n'));
    });

    it('the normalizer', () => {
      // A valid field typed in a form Engine writes differently, so the normalizer has work to do.
      writeFileSync(join(vaultPath, 'a.md'), task(`${typed}size: "2"\n`), 'utf-8');
      processFileChange(join(vaultPath, 'a.md'), 'a.md', db, writeLock, vaultPath);
      const stats = runNormalizerSweep(vaultPath, db, writeLock);
      expect(stats.errored).toBe(0);
      expect(read('a.md')).toBe(task(`${typed}size: 2\n`));
      // Once the file is canonical apart from the typed text, a later sweep leaves it alone.
      const again = runNormalizerSweep(vaultPath, db, writeLock);
      expect(again.rewritten).toBe(0);
    });

    it('an undo of a write', async () => {
      await ok('update-node', { file_path: 'a.md', set_fields: { size: 5 } });
      const operationId = (db.prepare(
        "SELECT operation_id FROM undo_operations WHERE source_tool = 'update-node' ORDER BY timestamp DESC, rowid DESC LIMIT 1",
      ).get() as { operation_id: string }).operation_id;
      await ok('undo-operations', { operation_ids: [operationId], dry_run: false });
      expect(read('a.md')).toBe(task(`${typed}size: 2\n`));
      expect(stored('a.md')).toEqual({ size: 2 });
      // The file the undo wrote is the one the database records.
      expect((db.prepare('SELECT content_hash FROM nodes WHERE file_path = ?').get('a.md') as { content_hash: string }).content_hash)
        .toBe(sha256(read('a.md')));
    });
  });

  describe('a write that stores the value the file already shows', () => {
    it('stores it, though the file does not change', async () => {
      type('a.md', task('status: bogus\n'));
      await ok('update-node', { file_path: 'a.md', remove_types: ['task'] });
      expect(read('a.md')).toBe('---\ntypes:\nstatus: bogus\n---\nBody\n');
      expect(stored('a.md')).toEqual({});

      // Unclaimed now, the value is valid: setting it stores it.
      await ok('update-node', { file_path: 'a.md', set_fields: { status: 'bogus' } });
      expect(stored('a.md')).toEqual({ status: 'bogus' });
      expect((await ok('get-node', { file_path: 'a.md' })).fields).toMatchObject({ status: { value: 'bogus' } });
    });

    it('stores a default it fills in while the file keeps the typed text', async () => {
      type('t.md', '---\ntypes:\n  - ticket\nseverity: extreme\ncode: a\n---\nBody\n');
      await ok('update-node', { file_path: 't.md', set_fields: { code: 'a' } });
      expect(read('t.md')).toBe('---\ntypes:\n  - ticket\nseverity: extreme\ncode: a\n---\nBody\n');
      expect(stored('t.md')).toEqual({ code: 'a', severity: 'low' });
    });
  });

  describe('a composed preview', () => {
    it('reads the fields it keeps from the earlier simulated write, as the live run reads the file', async () => {
      type('a.md', task('status: bogus\n'));
      const version = (db.prepare('SELECT version FROM nodes WHERE file_path = ?').get('a.md') as { version: number }).version;
      const operations = [
        { op: 'update', params: { file_path: 'a.md', set_fields: { status: 'open' } } },
        { op: 'update', params: { file_path: 'a.md', set_body: 'Body\n' } },
        { op: 'update', params: { file_path: 'a.md', set_body: 'Edited\n', expected_version: version + 1 } },
      ];

      // The second op changes nothing once the first wrote `status: open`, so the third
      // op's version still holds, in the preview as in the live run.
      const preview = await call('batch-mutate', { operations, dry_run: true });
      expect(preview.ok, JSON.stringify(preview)).toBe(true);
      expect(preview.warnings).toEqual([]);
      expect(preview.data.would_apply).toHaveLength(3);

      const live = await call('batch-mutate', { operations });
      expect(live.ok, JSON.stringify(live)).toBe(true);
      expect(live.warnings).toEqual([]);
      expect(read('a.md')).toBe(task('status: open\n', 'Edited\n'));
    });
  });

  describe('operations that change the field itself still change the file', () => {
    it('a type change that discards values that cannot convert', async () => {
      type('a.md', task('size: lots\ndue: 2026-01-02\n'));
      type('b.md', task('due: next to never\n'));
      expect(stored('b.md')).toEqual({});
      const result = await call('update-global-field', { name: 'due', field_type: 'number', confirm: true, discard_uncoercible: true });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      // The discarded value is gone from the file; the value the watcher rejected for
      // another field stays.
      expect(read('a.md')).toBe(task('size: lots\n'));
    });

    it('the undo of a type conversion writes the value it restores', async () => {
      type('a.md', task('status: bogus\nsize: 2\n'));
      await ok('update-global-field', { name: 'size', field_type: 'list', list_item_type: 'number', confirm: true });
      expect(read('a.md')).toBe(task('status: bogus\nsize:\n  - 2\n'));
      const operationId = (db.prepare(
        "SELECT operation_id FROM undo_operations WHERE source_tool = 'update-global-field' ORDER BY timestamp DESC, rowid DESC LIMIT 1",
      ).get() as { operation_id: string }).operation_id;
      await ok('undo-operations', { operation_ids: [operationId], dry_run: false });
      expect(read('a.md')).toBe(task('status: bogus\nsize: 2\n'));
    });

    it('the undo of a write restores a value the definitions now reject in the file', async () => {
      type('a.md', task('status: open\n'));
      await ok('update-node', { file_path: 'a.md', set_fields: { status: 'closed' } });
      const operationId = (db.prepare(
        "SELECT operation_id FROM undo_operations WHERE source_tool = 'update-node' ORDER BY timestamp DESC, rowid DESC LIMIT 1",
      ).get() as { operation_id: string }).operation_id;
      // `closed` is rejected from here on; the undo puts `open` back in the database.
      await ok('update-global-field', { name: 'status', enum_values: ['open'] });
      await ok('undo-operations', { operation_ids: [operationId], dry_run: false });
      expect(stored('a.md')).toEqual({ status: 'open' });
      expect(read('a.md')).toBe(task('status: open\n'));
      expect((db.prepare('SELECT content_hash FROM nodes WHERE file_path = ?').get('a.md') as { content_hash: string }).content_hash)
        .toBe(sha256(read('a.md')));
    });

    it('a global field rename writes the value under its new name only', async () => {
      type('a.md', task('status: open\nsize: lots\n'));
      await ok('rename-global-field', { old_name: 'status', new_name: 'state' });
      expect(read('a.md')).toBe(task('state: open\nsize: lots\n'));
    });
  });

  it('leaves queries, filters and validation as they were: the database does not hold the typed value', async () => {
    type('a.md', task('status: bogus\nsize: 2\n'));
    await ok('update-node', { file_path: 'a.md', set_body: 'Edited\n' });

    expect((await ok('query-nodes', { fields: { status: { eq: 'bogus' } } })).nodes ?? []).toHaveLength(0);
    expect((await ok('query-nodes', { types: ['task'], fields: { status: { exists: true } } })).nodes ?? []).toHaveLength(0);
    const node = await ok('get-node', { file_path: 'a.md' });
    expect(node.fields).not.toHaveProperty('status');
  });

  it('keeps schema edits working on a type whose notes hold typed values that fail validation', async () => {
    type('a.md', task('status: bogus\nsize: lots\n'));
    type('b.md', task('status: open\n'));
    type('b.md', task('status: nope\n'));

    await ok('update-schema', { name: 'task', add_field_claims: [{ field: 'label', sort_order: 9 }] });
    await ok('update-schema', { name: 'task', update_field_claims: [{ field: 'size', sort_order: 1 }] });

    expect(read('a.md')).toBe(task('size: lots\nstatus: bogus\n'));
    expect(read('b.md')).toBe(task('status: nope\n'));
    expect(stored('b.md')).toEqual({ status: 'open' });
  });

  describe('existing installation', () => {
    it('a note the previous version left with the value in its file only keeps it at the next tool write', async () => {
      // The state the previous version leaves: the watcher (unchanged by #501) rejected the
      // value and stored nothing for it; the file still shows it.
      const content = task('status: bogus\nsize: 2\n');
      type('a.md', content);
      expect(stored('a.md')).toEqual({ size: 2 });
      expect(rejected('status')).toMatchObject([{ source: 'watcher', rejected_value: 'bogus', retained_value: null }]);
      const hashBefore = (db.prepare('SELECT content_hash, version FROM nodes WHERE file_path = ?').get('a.md') as { content_hash: string; version: number });

      // Deploy: the startup index reads nothing new (the file matches its hash) and
      // nothing rewrites the note.
      await fullIndex(vaultPath, db);
      expect(read('a.md')).toBe(content);
      expect(stored('a.md')).toEqual({ size: 2 });
      expect(db.prepare('SELECT content_hash, version FROM nodes WHERE file_path = ?').get('a.md')).toEqual(hashBefore);

      // The next tool write keeps the value instead of erasing it.
      await ok('update-node', { file_path: 'a.md', set_body: 'Edited\n' });
      expect(read('a.md')).toBe(task('status: bogus\nsize: 2\n', 'Edited\n'));
      expect(stored('a.md')).toEqual({ size: 2 });
    });
  });
});
