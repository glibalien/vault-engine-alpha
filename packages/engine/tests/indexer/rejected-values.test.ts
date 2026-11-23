// The startup index takes a typed value that fails validation as the watcher does (#510).
//
// A note saved while Engine is not running is read at the next start by `fullIndex`. It
// stored every frontmatter value as given, so a value the watcher rejects (an enum miss,
// an uncoercible number, ...) went into the database, and from then on every tool write
// to the note and every `update-schema` on its types failed with VALIDATION_FAILED. Now
// the startup index stores no value for such a field, or keeps the one the database held,
// and logs `value-rejected`, as the watcher does for the same file. The file keeps the
// typed text, and later Engine writes keep it too (#501).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { registerAllTools } from '../../src/mcp/tools/index.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { renderFieldsFile, renderSchemaFile } from '../../src/schema/render.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { SyncLogger } from '../../src/sync/sync-logger.js';
import { processFileChange } from '../../src/sync/watcher.js';
import { fullIndex, indexFile } from '../../src/indexer/indexer.js';
import { sha256 } from '../../src/indexer/hash.js';
import { REFERENCE_POLICY_VERSION_KEY } from '../../src/db/reference-policy-version.js';

async function callTool(server: McpServer, name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }> }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return tool.callback ? tool.callback(args) : tool.handler(args);
}

const task = (lines: string, body = 'Body\n') => `---\ntypes:\n  - task\n${lines}---\n${body}`;

/** A vault and database with the definitions every test uses. */
class Install {
  readonly vaultPath = mkdtempSync(join(tmpdir(), 'rejected-values-'));
  readonly db: Database.Database = createTestDb();
  readonly writeLock = new WriteLockManager();
  readonly server = new McpServer({ name: 'test', version: '0' });

  constructor(policy: 1 | 2 = 1) {
    const db = this.db;
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(REFERENCE_POLICY_VERSION_KEY, String(policy));
    registerAllTools(this.server, db, { writeLock: this.writeLock, vaultPath: this.vaultPath, syncLogger: new SyncLogger(db) });
    createGlobalField(db, { name: 'status', field_type: 'enum', enum_values: ['open', 'closed'] });
    createGlobalField(db, { name: 'size', field_type: 'number' });
    createGlobalField(db, { name: 'due', field_type: 'date' });
    createGlobalField(db, { name: 'done', field_type: 'boolean' });
    createGlobalField(db, { name: 'scores', field_type: 'list', list_item_type: 'number' });
    createGlobalField(db, { name: 'owner', field_type: 'reference' });
    createGlobalField(db, { name: 'label', field_type: 'string' });
    createSchemaDefinition(db, {
      name: 'task',
      field_claims: [
        { field: 'status', sort_order: 1 },
        { field: 'size', sort_order: 2 },
        { field: 'due', sort_order: 3 },
        { field: 'done', sort_order: 4 },
        { field: 'scores', sort_order: 5 },
        { field: 'owner', sort_order: 6 },
      ],
    });
    renderFieldsFile(db, this.vaultPath);
    renderSchemaFile(db, this.vaultPath, 'task');
  }

  close(): void {
    this.db.close();
    rmSync(this.vaultPath, { recursive: true, force: true });
  }

  /** Save a file without Engine reading it (Engine is not running). */
  write(relPath: string, content: string): void {
    const abs = join(this.vaultPath, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }

  read(relPath: string): string {
    return readFileSync(join(this.vaultPath, relPath), 'utf-8');
  }

  /** The startup index. */
  index() {
    return fullIndex(this.vaultPath, this.db);
  }

  /** Save a file while Engine runs: the watcher reads it. */
  watch(relPath: string, content: string): void {
    this.write(relPath, content);
    processFileChange(join(this.vaultPath, relPath), relPath, this.db, this.writeLock, this.vaultPath);
  }

  stored(relPath: string): Record<string, unknown> {
    const rows = this.db.prepare(`
      SELECT f.field_name, f.value_text, f.value_number, f.value_date, f.value_json
      FROM node_fields f JOIN nodes n ON n.id = f.node_id
      WHERE n.file_path = ?
      ORDER BY f.field_name
    `).all(relPath) as Array<{ field_name: string; value_text: string | null; value_number: number | null; value_date: string | null; value_json: string | null }>;
    return Object.fromEntries(rows.map(r => [r.field_name,
      r.value_json !== null ? JSON.parse(r.value_json) : r.value_text ?? r.value_number ?? r.value_date]));
  }

  /** Every stored row of the note, as a reader of the database sees it. */
  rows(relPath: string) {
    const id = this.nodeId(relPath);
    return {
      node: this.db.prepare('SELECT file_path, title, body, content_hash, file_mtime, version FROM nodes WHERE id = ?').get(id),
      fields: this.db.prepare('SELECT field_name, value_text, value_number, value_date, value_json, value_raw_text, source FROM node_fields WHERE node_id = ? ORDER BY field_name').all(id),
      relationships: this.db.prepare('SELECT target, rel_type, context, resolved_target_id FROM relationships WHERE source_id = ? ORDER BY target, rel_type').all(id),
      editsLog: this.db.prepare('SELECT event_type, details FROM edits_log WHERE node_id = ? ORDER BY id').all(id),
    };
  }

  relationships(relPath: string): Array<{ target: string; rel_type: string }> {
    return this.db.prepare('SELECT target, rel_type FROM relationships WHERE source_id = ? ORDER BY target, rel_type')
      .all(this.nodeId(relPath)) as Array<{ target: string; rel_type: string }>;
  }

  rejected(field: string): Array<Record<string, unknown>> {
    return (this.db.prepare(`SELECT details FROM edits_log WHERE event_type = 'value-rejected' ORDER BY id`).all() as Array<{ details: string }>)
      .map(row => JSON.parse(row.details) as Record<string, unknown>)
      .filter(details => details.field === field);
  }

  nodeId(relPath: string): string {
    return (this.db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(relPath) as { id: string }).id;
  }

  async call(name: string, args: Record<string, unknown>) {
    return JSON.parse((await callTool(this.server, name, args)).content[0].text);
  }

  async ok(name: string, args: Record<string, unknown>) {
    const result = await this.call(name, args);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    return result.data;
  }
}

/** A rejection as the edits log records it, without the reader that logged it. */
function withoutSource(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map(({ source: _source, ...rest }) => rest);
}

describe('the startup index takes a typed value that fails validation as the watcher does (#510)', () => {
  let install: Install;
  let watcher: Install;

  beforeEach(() => {
    install = new Install();
    watcher = new Install();
  });

  afterEach(() => {
    install.close();
    watcher.close();
  });

  describe('a field the database held no value for', () => {
    it.each([
      ['an enum value outside the list', 'status: bogus\n', 'ENUM_MISMATCH'],
      ['an uncoercible number', 'size: lots\n', 'TYPE_MISMATCH'],
      ['an uncoercible date', 'due: not a date at all\n', 'TYPE_MISMATCH'],
      ['an uncoercible boolean', 'done: maybe\n', 'TYPE_MISMATCH'],
      ['a list item of the wrong type', 'scores: [1, two, 3]\n', 'LIST_ITEM_COERCION_FAILED'],
      ['a reference that is not a name', 'owner: 42\n', 'TYPE_MISMATCH'],
      ['a quoted enum value with a comment', 'status: "Bogus value"  # typed by hand\n', 'ENUM_MISMATCH'],
    ])('stores no value for %s and logs value-rejected, as the watcher does', (_label, line, reasonCode) => {
      const field = line.slice(0, line.indexOf(':'));
      install.write('a.md', task(line));
      install.index();

      expect(install.stored('a.md')).toEqual({});
      expect(install.rejected(field)).toMatchObject([{ source: 'fullIndex', retained_value: null, reason_code: reasonCode, node_types: ['task'] }]);
      expect(install.read('a.md')).toBe(task(line));

      watcher.watch('a.md', task(line));
      expect(watcher.stored('a.md')).toEqual(install.stored('a.md'));
      expect(withoutSource(install.rejected(field))).toEqual(withoutSource(watcher.rejected(field)));
    });

    it('stores the valid values beside it as before', () => {
      install.write('a.md', task('status: bogus\nsize: 3\nowner: "[[Someone]]"\nnote: free text\n'));
      install.index();

      expect(install.stored('a.md')).toEqual({ size: 3, owner: 'Someone', note: 'free text' });
      // The raw text of a link is kept as the startup index has always kept it.
      expect(install.rows('a.md').fields).toContainEqual(expect.objectContaining({ field_name: 'owner', value_raw_text: '[[Someone]]' }));
      expect(install.relationships('a.md')).toEqual([{ target: 'Someone', rel_type: 'owner' }]);
    });

    it('lets tool writes and schema edits work on the note, and keeps the typed text in its file', async () => {
      install.write('a.md', task('status: bogus\nsize: 2\n'));
      install.index();

      await install.ok('update-node', { file_path: 'a.md', set_body: 'Edited\n' });
      expect(install.read('a.md')).toBe(task('status: bogus\nsize: 2\n', 'Edited\n'));
      expect(install.stored('a.md')).toEqual({ size: 2 });

      await install.ok('update-schema', { name: 'task', add_field_claims: [{ field: 'label', sort_order: 9 }] });
      expect(install.read('a.md')).toContain('status: bogus\n');
      expect((await install.ok('query-nodes', { fields: { status: { eq: 'bogus' } } })).nodes ?? []).toHaveLength(0);
    });

    it.each([1, 2] as const)('records no relationship from a link in a value it does not store, under reference policy %i', (policy) => {
      const v = new Install(policy);
      try {
        v.write('a.md', task('status: "[[Elsewhere]]"\nscores:\n  - 1\n  - "[[Nested]]"\nsize: 2\n', 'See [[Other]] and [[status]]\n'));
        v.index();

        expect(v.stored('a.md')).toEqual({ size: 2 });
        expect(v.relationships('a.md')).toEqual([
          { target: 'Other', rel_type: 'wiki-link' },
          { target: 'status', rel_type: 'wiki-link' },
        ]);
      } finally {
        v.close();
      }
    });

    it('applies the same rule when one file is indexed alone', () => {
      install.write('a.md', task('status: bogus\nsize: 2\n'));
      indexFile(join(install.vaultPath, 'a.md'), install.vaultPath, install.db);

      expect(install.stored('a.md')).toEqual({ size: 2 });
      expect(install.rejected('status')).toMatchObject([{ source: 'indexFile', rejected_value: 'bogus', retained_value: null }]);
    });
  });

  describe('a field the database held a value for', () => {
    it('keeps the stored value when the file was changed to one that fails validation while Engine was down', async () => {
      install.write('a.md', task('status: open\nsize: 2\n'));
      install.index();
      install.write('a.md', task('status: bogus\nsize: 3\n'));
      install.index();

      expect(install.stored('a.md')).toEqual({ status: 'open', size: 3 });
      expect(install.rejected('status')).toMatchObject([{ source: 'fullIndex', rejected_value: 'bogus', retained_value: 'open' }]);

      watcher.watch('a.md', task('status: open\nsize: 2\n'));
      watcher.watch('a.md', task('status: bogus\nsize: 3\n'));
      expect(watcher.stored('a.md')).toEqual(install.stored('a.md'));
      expect(withoutSource(install.rejected('status'))).toEqual(withoutSource(watcher.rejected('status')));

      // The next tool write keeps the typed text; the database keeps the stored value (#501).
      await install.ok('update-node', { file_path: 'a.md', set_body: 'Edited\n' });
      expect(install.read('a.md')).toBe(task('status: bogus\nsize: 3\n', 'Edited\n'));
      expect(install.stored('a.md')).toEqual({ status: 'open', size: 3 });
    });

    it.each([1, 2] as const)('keeps the stored value\'s relationship, under reference policy %i', (policy) => {
      const v = new Install(policy);
      try {
        v.write('Someone.md', '# Someone\n');
        v.write('a.md', task('owner: "[[Someone]]"\n'));
        v.index();
        const before = v.rows('a.md');
        v.write('a.md', task('owner: 42\n'));
        v.index();

        expect(v.stored('a.md')).toEqual({ owner: 'Someone' });
        expect(v.rows('a.md').fields).toEqual(before.fields);
        expect(v.rows('a.md').relationships).toEqual(before.relationships);
        expect(v.relationships('a.md')).toEqual([{ target: 'Someone', rel_type: 'owner' }]);
      } finally {
        v.close();
      }
    });
  });

  describe('a note with nothing to validate is stored exactly as before', () => {
    it.each([
      ['a type without a schema', '---\ntypes:\n  - draft\nstatus: bogus\nsize: lots\n---\nBody\n', { status: 'bogus', size: 'lots' }],
      ['no type', '---\nstatus: bogus\n---\nBody\n', { status: 'bogus' }],
      ['a field its type does not claim', task('mood: "[[Elsewhere]]"\nlabel: 7\n'), { mood: 'Elsewhere', label: 7 }],
    ])('%s', (_label, content, expected) => {
      install.write('a.md', content);
      install.index();

      expect(install.stored('a.md')).toEqual(expected);
      expect(install.db.prepare(`SELECT COUNT(*) AS n FROM edits_log WHERE event_type = 'value-rejected'`).get()).toEqual({ n: 0 });
    });

    it('on a brand-new install, whose first index runs before any schema exists', () => {
      const fresh = createTestDb();
      const vault = mkdtempSync(join(tmpdir(), 'rejected-values-fresh-'));
      try {
        writeFileSync(join(vault, 'a.md'), task('status: bogus\nowner: "[[Someone]]"\n'), 'utf-8');
        fullIndex(vault, fresh);
        const fields = fresh.prepare('SELECT field_name, value_text, value_raw_text FROM node_fields ORDER BY field_name').all();
        expect(fields).toEqual([
          { field_name: 'owner', value_text: 'Someone', value_raw_text: '[[Someone]]' },
          { field_name: 'status', value_text: 'bogus', value_raw_text: null },
        ]);
      } finally {
        fresh.close();
        rmSync(vault, { recursive: true, force: true });
      }
    });
  });

  describe('existing installation', () => {
    /**
     * The state the previous version leaves for a note saved while Engine was down: its
     * startup index stored the typed value as given. The file is unchanged since.
     */
    function previousVersionState(content: string): void {
      install.write('a.md', content);
      install.index();
      const id = install.nodeId('a.md');
      install.db.prepare(`INSERT OR REPLACE INTO node_fields (node_id, field_name, value_text, value_number, value_date, value_json, value_raw_text, source)
        VALUES (?, 'status', 'bogus', NULL, NULL, NULL, NULL, 'frontmatter')`).run(id);
      install.db.prepare(`DELETE FROM edits_log WHERE event_type = 'value-rejected'`).run();
      expect(install.stored('a.md')).toMatchObject({ status: 'bogus' });
    }

    it('a restart changes nothing for a note whose file has not changed', () => {
      previousVersionState(task('status: bogus\nsize: 2\n'));
      const before = install.rows('a.md');

      install.index();
      expect(install.rows('a.md')).toEqual(before);

      // A file touched without a change: only its recorded mtime moves, as before.
      const later = new Date(Date.now() + 60_000);
      utimesSync(join(install.vaultPath, 'a.md'), later, later);
      install.index();
      const after = install.rows('a.md');
      expect(after.fields).toEqual(before.fields);
      expect(after.relationships).toEqual(before.relationships);
      expect(after.editsLog).toEqual(before.editsLog);
      expect({ ...(after.node as object), file_mtime: 0 }).toEqual({ ...(before.node as object), file_mtime: 0 });
    });

    it('a note moved while Engine was down keeps every stored value, as the watcher keeps them', () => {
      previousVersionState(task('status: bogus\nsize: 2\n'));
      const before = install.rows('a.md');
      mkdirSync(join(install.vaultPath, 'Moved'));
      renameSync(join(install.vaultPath, 'a.md'), join(install.vaultPath, 'Moved/a.md'));

      install.index();

      expect(install.rows('Moved/a.md').fields).toEqual(before.fields);
      expect(install.rejected('status')).toMatchObject([{ source: 'fullIndex', rejected_value: 'bogus', retained_value: 'bogus' }]);
    });

    it.each([
      [1, 'body edited', 'owner:\n  link: "[[Someone]]"\n'],
      [2, 'body edited', 'owner:\n  link: "[[Someone]]"\n'],
      [1, 'value changed to another that fails', 'owner:\n  link: "[[Elsewhere]]"\n'],
      [2, 'value changed to another that fails', 'owner:\n  link: "[[Elsewhere]]"\n'],
    ] as const)('a value stored as given keeps its relationships, nested links included (policy %i, %s)', (policy, _edited, edited) => {
      const v = new Install(policy);
      try {
        // As the previous version's startup index left it: the object stored as given, and
        // the link the parser found inside it recorded as an `owner` relationship.
        v.write('Someone.md', '# Someone\n');
        v.write('a.md', task('owner:\n  link: "[[Someone]]"\n'));
        v.index();
        const id = v.nodeId('a.md');
        v.db.prepare(`INSERT OR REPLACE INTO node_fields (node_id, field_name, value_text, value_number, value_date, value_json, value_raw_text, source)
          VALUES (?, 'owner', NULL, NULL, NULL, '{"link":"Someone"}', NULL, 'frontmatter')`).run(id);
        v.db.prepare(`INSERT OR IGNORE INTO relationships (source_id, target, rel_type, context, resolved_target_id)
          VALUES (?, 'Someone', 'owner', 'owner', ?)`).run(id, v.nodeId('Someone.md'));
        const before = v.rows('a.md');

        // Edited while Engine was down; the file still holds a value that fails.
        v.write('a.md', task(edited, 'Edited\n'));
        v.index();

        expect(v.rows('a.md').fields).toEqual(before.fields);
        expect(v.rows('a.md').relationships).toEqual(before.relationships);
        expect(v.relationships('a.md')).toEqual([{ target: 'Someone', rel_type: 'owner' }]);
      } finally {
        v.close();
      }
    });

    it('a stored value that fails validation stays until the file\'s value changes, as with the watcher', () => {
      previousVersionState(task('status: bogus\nsize: 2\n'));

      // Edited while Engine was down; the typed value is still there.
      install.write('a.md', task('status: bogus\nsize: 3\n'));
      install.index();
      expect(install.stored('a.md')).toEqual({ status: 'bogus', size: 3 });

      // The watcher, from the same stored state and the same file.
      watcher.watch('a.md', task('status: bogus\nsize: 2\n'));
      const id = watcher.nodeId('a.md');
      watcher.db.prepare(`INSERT OR REPLACE INTO node_fields (node_id, field_name, value_text, value_number, value_date, value_json, value_raw_text, source)
        VALUES (?, 'status', 'bogus', NULL, NULL, NULL, NULL, 'frontmatter')`).run(id);
      watcher.watch('a.md', task('status: bogus\nsize: 3\n'));
      expect(watcher.stored('a.md')).toEqual(install.stored('a.md'));

      // A valid value replaces it.
      install.write('a.md', task('status: closed\nsize: 3\n'));
      install.index();
      expect(install.stored('a.md')).toEqual({ status: 'closed', size: 3 });
      expect(install.db.prepare('SELECT content_hash FROM nodes WHERE file_path = ?').get('a.md'))
        .toEqual({ content_hash: sha256(install.read('a.md')) });
    });
  });
});
