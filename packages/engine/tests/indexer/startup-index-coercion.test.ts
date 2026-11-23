// The startup index stores a file's values as the watcher stores them (#515).
//
// A note saved while Engine is not running is read at the next start by `fullIndex` (or
// one file by `indexFile`). It stored every accepted value as given. Now, as the watcher
// (`processFileChange`, source `watcher`) does for the same file and database state, it
// stores each value as validation coerces it (`status: Open` as `open`, `size: "3"` as 3),
// fills the default of a required field the file leaves out, and keeps the stored value of
// a required field without a default that the file leaves out or empty. Its edits-log rows
// are the watcher's, with `source` naming the index, but it logs a coercion only when the
// coercion changes what is stored: a strict ISO date, which validation marks coerced, is
// stored as written and logged by the watcher only.
//
// Not changed (#515 item 4): the index keeps the raw link text of claimed fields, and under
// reference policy 1 records links in any field. Parity is checked on values and log rows.

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
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { SyncLogger } from '../../src/sync/sync-logger.js';
import { processFileChange } from '../../src/sync/watcher.js';
import { fullIndex, indexFile } from '../../src/indexer/indexer.js';
import { backfillResolvedTargets } from '../../src/resolver/refresh.js';
import { REFERENCE_POLICY_VERSION_KEY } from '../../src/db/reference-policy-version.js';

const DEVIATIONS = ['value-coerced', 'value-rejected', 'field-defaulted'];

/** Call a tool on a server holding the installation's database, as an MCP client would. */
async function callTool(install: { db: Database.Database; writeLock: WriteLockManager; vaultPath: string },
  name: string, args: Record<string, unknown>) {
  const server = new McpServer({ name: 'test', version: '0' });
  registerAllTools(server, install.db, { writeLock: install.writeLock, vaultPath: install.vaultPath, syncLogger: new SyncLogger(install.db) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  const result = await (tool.callback ? tool.callback(args) : tool.handler(args));
  return JSON.parse(result.content[0].text);
}

const note = (types: string[], lines: string, body = 'Body\n') =>
  `---\ntypes:\n${types.map(type => `  - ${type}\n`).join('')}${lines}---\n${body}`;
const task = (lines: string, body?: string) => note(['task'], lines, body);

/** The global fields and schemas, defined in a database. */
function define(db: Database.Database): void {
  createGlobalField(db, { name: 'status', field_type: 'enum', enum_values: ['open', 'closed'] });
  createGlobalField(db, { name: 'size', field_type: 'number' });
  createGlobalField(db, { name: 'due', field_type: 'date' });
  createGlobalField(db, { name: 'done', field_type: 'boolean' });
  createGlobalField(db, { name: 'scores', field_type: 'list', list_item_type: 'number' });
  createGlobalField(db, { name: 'owner', field_type: 'reference' });
  createGlobalField(db, { name: 'priority', field_type: 'enum', enum_values: ['low', 'normal', 'high'], required: true, default_value: 'normal' });
  createGlobalField(db, { name: 'reviewer', field_type: 'string', required: true });
  createGlobalField(db, { name: 'lead', field_type: 'reference', required: true, default_value: 'Lead Person' });
  createGlobalField(db, { name: 'stamp', field_type: 'string', required: true, default_value: '$mtime:YYYY-MM-DD HH:mm:ss' });
  createSchemaDefinition(db, {
    name: 'task',
    field_claims: ['status', 'size', 'due', 'done', 'scores', 'owner', 'priority'].map((field, i) => ({ field, sort_order: i + 1 })),
  });
  createSchemaDefinition(db, { name: 'review', field_claims: [{ field: 'reviewer', sort_order: 1 }] });
  createSchemaDefinition(db, { name: 'meeting', field_claims: [{ field: 'lead', sort_order: 1 }, { field: 'stamp', sort_order: 2 }] });
}

/** A vault and its database. */
class Install {
  readonly vaultPath = mkdtempSync(join(tmpdir(), 'startup-index-coercion-'));
  readonly db: Database.Database = createTestDb();
  readonly writeLock = new WriteLockManager();

  constructor(policy: 1 | 2 = 1, schemas = true) {
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(REFERENCE_POLICY_VERSION_KEY, String(policy));
    if (schemas) define(this.db);
  }

  close(): void {
    this.db.close();
    rmSync(this.vaultPath, { recursive: true, force: true });
  }

  /** Save a file without Engine reading it (Engine is not running). */
  write(relPath: string, content: string, mtime?: Date): void {
    const abs = join(this.vaultPath, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
    if (mtime) utimesSync(abs, mtime, mtime);
  }

  read(relPath: string): string {
    return readFileSync(join(this.vaultPath, relPath), 'utf-8');
  }

  /** The startup index, and the backfill that follows it. */
  index() {
    const stats = fullIndex(this.vaultPath, this.db);
    backfillResolvedTargets(this.db);
    return stats;
  }

  /** Save a file while Engine runs: the watcher reads it. */
  watch(relPath: string, content: string, mtime?: Date): void {
    this.write(relPath, content, mtime);
    processFileChange(join(this.vaultPath, relPath), relPath, this.db, this.writeLock, this.vaultPath);
  }

  nodeId(relPath: string): string {
    return (this.db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(relPath) as { id: string }).id;
  }

  /** The stored value of each field, as a reader of the database sees it. */
  stored(relPath: string): Record<string, unknown> {
    const rows = this.db.prepare(`SELECT field_name, value_text, value_number, value_date, value_json FROM node_fields
      WHERE node_id = ? ORDER BY field_name`).all(this.nodeId(relPath)) as Array<{ field_name: string; value_text: string | null;
      value_number: number | null; value_date: string | null; value_json: string | null }>;
    return Object.fromEntries(rows.map(r => [r.field_name,
      r.value_json !== null ? JSON.parse(r.value_json) : r.value_number ?? r.value_date ?? r.value_text]));
  }

  /** The stored field rows, without the raw link text, which the two readers keep differently (#515 item 4). */
  fieldRows(relPath: string) {
    return this.db.prepare(`SELECT field_name, value_text, value_number, value_date, value_json FROM node_fields
      WHERE node_id = ? ORDER BY field_name`).all(this.nodeId(relPath));
  }

  explicitNulls(relPath: string) {
    return this.db.prepare('SELECT field_name FROM node_explicit_null_fields WHERE node_id = ? ORDER BY field_name').all(this.nodeId(relPath));
  }

  relationships(relPath: string) {
    return (this.db.prepare(`SELECT r.target, r.rel_type, t.file_path AS bound FROM relationships r
      LEFT JOIN nodes t ON t.id = r.resolved_target_id WHERE r.source_id = ? ORDER BY r.target, r.rel_type`)
      .all(this.nodeId(relPath)));
  }

  /** The note's deviation rows after edits-log row `after`, without the reader that logged them. */
  deviations(relPath: string, after = 0): Array<{ event_type: string; details: Record<string, unknown> }> {
    const rows = this.db.prepare(`SELECT event_type, details FROM edits_log WHERE node_id = ? AND id > ?
      AND event_type IN (${DEVIATIONS.map(() => '?').join(', ')}) ORDER BY id`)
      .all(this.nodeId(relPath), after, ...DEVIATIONS) as Array<{ event_type: string; details: string }>;
    return rows.map(row => {
      const { source: _source, ...details } = JSON.parse(row.details) as Record<string, unknown>;
      return { event_type: row.event_type, details };
    });
  }

  sources(relPath: string, after = 0): string[] {
    return (this.db.prepare(`SELECT details FROM edits_log WHERE node_id = ? AND id > ? AND event_type IN (${DEVIATIONS.map(() => '?').join(', ')})`)
      .all(this.nodeId(relPath), after, ...DEVIATIONS) as Array<{ details: string }>)
      .map(row => (JSON.parse(row.details) as { source: string }).source);
  }

  lastLogId(): number {
    return (this.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM edits_log').get() as { id: number }).id;
  }
}

/** The watcher's rows, less the coercions that leave the value as written, which the index does not log. */
function withoutUnchangedCoercions(rows: Array<{ event_type: string; details: Record<string, unknown> }>) {
  return rows.filter(row => !(row.event_type === 'value-coerced'
    && JSON.stringify(row.details.original_value) === JSON.stringify(row.details.coerced_value)));
}

describe.each([1, 2] as const)('the startup index stores a file\'s values as the watcher does, under reference policy %i (#515)', (policy) => {
  let indexed: Install;
  let watched: Install;

  beforeEach(() => {
    indexed = new Install(policy);
    watched = new Install(policy);
  });

  afterEach(() => {
    indexed.close();
    watched.close();
  });

  /**
   * The same saves in both installations: `before` (if any) read by the watcher in both,
   * then `after` saved while Engine was down and read by the startup index in one, and
   * saved while it ran in the other.
   */
  function both(relPath: string, after: string, before?: string): { indexedFrom: number; watchedFrom: number } {
    const mtime = new Date('2026-03-04T05:06:07Z');
    if (before !== undefined) {
      indexed.watch(relPath, before);
      watched.watch(relPath, before);
    }
    const indexedFrom = indexed.lastLogId();
    const watchedFrom = watched.lastLogId();
    indexed.write(relPath, after, mtime);
    indexed.index();
    watched.watch(relPath, after, mtime);
    return { indexedFrom, watchedFrom };
  }

  function expectParity(relPath: string, from: { indexedFrom: number; watchedFrom: number }) {
    expect(indexed.fieldRows(relPath)).toEqual(watched.fieldRows(relPath));
    expect(indexed.explicitNulls(relPath)).toEqual(watched.explicitNulls(relPath));
    expect(indexed.deviations(relPath, from.indexedFrom))
      .toEqual(withoutUnchangedCoercions(watched.deviations(relPath, from.watchedFrom)));
    expect(new Set(indexed.sources(relPath, from.indexedFrom))).toEqual(new Set(indexed.deviations(relPath, from.indexedFrom).length > 0 ? ['fullIndex'] : []));
  }

  describe('1. coercion', () => {
    it('stores each value as validation coerces it, and logs each coercion that changes it', () => {
      const from = both('a.md', task('status: Open\nsize: "3"\ndone: "yes"\nscores: ["1", 2]\npriority: High\n'));

      expect(indexed.stored('a.md')).toEqual({ status: 'open', size: 3, done: true, scores: [1, 2], priority: 'high' });
      expectParity('a.md', from);
      expect(indexed.deviations('a.md', from.indexedFrom).map(row => [row.event_type, row.details.field])).toEqual([
        ['value-coerced', 'status'], ['value-coerced', 'size'], ['value-coerced', 'done'], ['value-coerced', 'scores'],
        ['value-coerced', 'priority'],
      ]);
      expect(indexed.read('a.md')).toBe(task('status: Open\nsize: "3"\ndone: "yes"\nscores: ["1", 2]\npriority: High\n'));
    });

    it('logs no coercion for a strict ISO date, which it stores as written; the watcher logs one', () => {
      const from = both('a.md', task('due: 2026-01-05\npriority: low\n'));

      expect(indexed.stored('a.md')).toEqual({ due: '2026-01-05', priority: 'low' });
      expectParity('a.md', from);
      expect(indexed.deviations('a.md', from.indexedFrom)).toEqual([]);
      expect(watched.deviations('a.md', from.watchedFrom)).toMatchObject([
        { event_type: 'value-coerced', details: { field: 'due', original_value: '2026-01-05', coerced_value: '2026-01-05' } },
      ]);
    });

    it('logs a date it rewrites', () => {
      const from = both('a.md', task('due: 6 March 2020\npriority: low\n'));

      expect(indexed.stored('a.md')).toEqual({ due: '2020-03-06', priority: 'low' });
      expectParity('a.md', from);
      expect(indexed.deviations('a.md', from.indexedFrom)).toMatchObject([
        { event_type: 'value-coerced', details: { field: 'due', original_value: '6 March 2020', coerced_value: '2020-03-06' } },
      ]);
    });

    it('finds the note by its coerced value, as one the watcher read', async () => {
      both('a.md', task('status: Open\npriority: low\n'));
      for (const install of [indexed, watched]) {
        const result = await callTool(install, 'query-nodes', { fields: { status: { eq: 'open' } } });
        expect(result.ok, JSON.stringify(result)).toBe(true);
        expect(result.data.nodes.map((n: { file_path: string }) => n.file_path)).toEqual(['a.md']);
      }
    });

    it('records a coerced reference\'s relationship as before', () => {
      const from = both('a.md', task('status: Open\nowner: "[[Someone]]"\npriority: low\n'));

      expect(indexed.stored('a.md')).toEqual({ status: 'open', owner: 'Someone', priority: 'low' });
      expectParity('a.md', from);
      expect(indexed.relationships('a.md')).toEqual([{ target: 'Someone', rel_type: 'owner', bound: null }]);
      expect(indexed.relationships('a.md')).toEqual(watched.relationships('a.md'));
    });
  });

  describe('2. a required field with a default that the file leaves out', () => {
    it('stores the default, in the database only, and logs field-defaulted', () => {
      const from = both('a.md', task('status: open\n'));

      expect(indexed.stored('a.md')).toEqual({ status: 'open', priority: 'normal' });
      expectParity('a.md', from);
      expect(indexed.deviations('a.md', from.indexedFrom)).toEqual([
        { event_type: 'field-defaulted', details: { field: 'priority', default_value: 'normal', default_source: 'global', node_types: ['task'] } },
      ]);
      expect(indexed.read('a.md')).toBe(task('status: open\n'));
    });

    it('reads a date token in a default from the file, as the watcher does', () => {
      const from = both('m.md', note(['meeting'], 'lead: "[[Someone]]"\n'));

      expect(indexed.stored('m.md')).toMatchObject({ stamp: expect.stringMatching(/^2026-03-0\d \d\d:\d\d:07$/) });
      expectParity('m.md', from);
    });

    it('records the relationship of a default that names a note', () => {
      for (const install of [indexed, watched]) install.watch('People/Lead Person.md', '# Lead\n');
      const from = both('m.md', note(['meeting'], 'stamp: set\n'));

      expect(indexed.stored('m.md')).toEqual({ lead: 'Lead Person', stamp: 'set' });
      expectParity('m.md', from);
      expect(indexed.relationships('m.md')).toEqual([{ target: 'Lead Person', rel_type: 'lead', bound: 'People/Lead Person.md' }]);
      expect(indexed.relationships('m.md')).toEqual(watched.relationships('m.md'));
    });

    it('keeps the stored value when the file holds the field empty, as for a field without a default', () => {
      const from = both('a.md', task('priority:\n'), task('priority: high\n'));

      expect(indexed.stored('a.md')).toEqual({ priority: 'high' });
      expectParity('a.md', from);
      expect(indexed.deviations('a.md', from.indexedFrom)).toMatchObject([
        { event_type: 'value-rejected', details: { field: 'priority', retained_value: 'high', reason_code: 'REQUIRED_MISSING' } },
      ]);
    });
  });

  describe('3. a required field without a default that the file leaves out', () => {
    it('keeps the stored value, and logs value-rejected', () => {
      const from = both('r.md', note(['review'], ''), note(['review'], 'reviewer: Ann Example\n'));

      expect(indexed.stored('r.md')).toEqual({ reviewer: 'Ann Example' });
      expectParity('r.md', from);
      expect(indexed.deviations('r.md', from.indexedFrom)).toMatchObject([
        { event_type: 'value-rejected', details: { field: 'reviewer', retained_value: 'Ann Example', reason_code: 'REQUIRED_MISSING' } },
      ]);
    });

    it('keeps the stored value when the file holds it empty', () => {
      const from = both('r.md', note(['review'], 'reviewer:\n'), note(['review'], 'reviewer: Ann Example\n'));

      expect(indexed.stored('r.md')).toEqual({ reviewer: 'Ann Example' });
      expect(indexed.explicitNulls('r.md')).toEqual([{ field_name: 'reviewer' }]);
      expectParity('r.md', from);
    });

    it('stores nothing for a note that had no value, and logs value-rejected', () => {
      const from = both('r.md', note(['review'], 'other: x\n'));

      expect(indexed.stored('r.md')).toEqual({ other: 'x' });
      expectParity('r.md', from);
      expect(indexed.deviations('r.md', from.indexedFrom)).toMatchObject([
        { event_type: 'value-rejected', details: { field: 'reviewer', retained_value: null, reason_code: 'REQUIRED_MISSING' } },
      ]);
    });

    it('lets tool writes to the note work, as after the watcher read it', async () => {
      both('r.md', note(['review'], ''), note(['review'], 'reviewer: Ann Example\n'));
      const result = await callTool(indexed, 'update-node', { file_path: 'r.md', set_body: 'Edited\n' });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(indexed.stored('r.md')).toEqual({ reviewer: 'Ann Example' });
    });
  });

  it('applies the same rules when one file is indexed alone', () => {
    indexed.watch('a.md', task('status: open\n'));
    indexed.write('a.md', task('status: Open\nsize: "3"\ndue: 2026-01-05\n'));
    const from = indexed.lastLogId();
    indexFile(join(indexed.vaultPath, 'a.md'), indexed.vaultPath, indexed.db);

    expect(indexed.stored('a.md')).toEqual({ status: 'open', size: 3, due: '2026-01-05', priority: 'normal' });
    expect(indexed.deviations('a.md', from).map(row => [row.event_type, row.details.field]))
      .toEqual([['value-coerced', 'status'], ['value-coerced', 'size'], ['field-defaulted', 'priority']]);
    expect(new Set(indexed.sources('a.md', from))).toEqual(new Set(['indexFile']));
  });

  describe('a note with nothing to validate is stored exactly as before', () => {
    it.each([
      ['a type without a schema', note(['draft'], 'status: Open\nsize: "3"\n'), { status: 'Open', size: '3' }],
      ['no type', '---\nstatus: Open\n---\nBody\n', { status: 'Open' }],
      ['a field its type does not claim', note(['review'], 'reviewer: x\nmood: Open\nlabel: "7"\n'), { reviewer: 'x', mood: 'Open', label: '7' }],
    ])('%s', (_label, content, expected) => {
      indexed.write('a.md', content);
      indexed.index();

      expect(indexed.stored('a.md')).toEqual(expected);
      expect(indexed.deviations('a.md')).toEqual([]);
    });

    it('on a brand-new install, whose first index runs before any schema exists', () => {
      const fresh = new Install(1, false);
      try {
        fresh.write('a.md', task('status: Open\nsize: "3"\nowner: "[[Someone]]"\n'));
        fresh.index();
        expect(fresh.db.prepare('SELECT field_name, value_text, value_number, value_raw_text FROM node_fields ORDER BY field_name').all()).toEqual([
          { field_name: 'owner', value_text: 'Someone', value_number: null, value_raw_text: '[[Someone]]' },
          { field_name: 'size', value_text: '3', value_number: null, value_raw_text: null },
          { field_name: 'status', value_text: 'Open', value_number: null, value_raw_text: null },
        ]);
        expect(fresh.deviations('a.md')).toEqual([]);
      } finally {
        fresh.close();
      }
    });
  });
});

describe('an existing installation (#515)', () => {
  let install: Install;

  /**
   * The state the previous version leaves: its startup index stored every value as given
   * (`status: Open`, `size: "3"`), filled no default and kept no required value. That is
   * what this index stores before the schemas exist, so the schemas are defined after.
   */
  beforeEach(() => {
    install = new Install(1, false);
    install.write('a.md', task('status: Open\nsize: "3"\ndue: 2026-01-05\nowner: "[[Someone]]"\n'));
    install.write('r.md', note(['review'], 'other: x\n'));
    install.write('Someone.md', '# Someone\n');
    install.index();
    define(install.db);
    expect(install.stored('a.md')).toEqual({ status: 'Open', size: '3', due: '2026-01-05', owner: 'Someone' });
  });

  afterEach(() => install.close());

  /** Every stored row of every note a reader sees, the edits log included. */
  function everything() {
    const all = (sql: string) => install.db.prepare(sql).all();
    return {
      nodes: all('SELECT rowid, * FROM nodes ORDER BY rowid'),
      types: all('SELECT * FROM node_types ORDER BY node_id, sort_order'),
      fields: all('SELECT * FROM node_fields ORDER BY node_id, field_name'),
      explicitNulls: all('SELECT * FROM node_explicit_null_fields ORDER BY node_id, field_name'),
      relationships: all('SELECT * FROM relationships ORDER BY id'),
      editsLog: all('SELECT * FROM edits_log ORDER BY id'),
    };
  }

  it('a restart changes no stored row of a note whose file has not changed', () => {
    const before = everything();
    install.index();
    expect(everything()).toEqual(before);
    expect(install.stored('a.md')).toMatchObject({ status: 'Open', size: '3' });

    // Saved again without a change: only the recorded mtime moves, as before.
    const future = new Date(Date.now() + 5000);
    utimesSync(join(install.vaultPath, 'a.md'), future, future);
    install.index();
    const after = everything();
    const moved = (before.nodes as Array<{ file_path: string; file_mtime: number }>).find(node => node.file_path === 'a.md')!;
    moved.file_mtime = Math.floor(future.getTime());
    expect(after).toEqual(before);
  });

  it('a value stored as given stays until the file is next read', () => {
    install.index();
    expect(install.stored('a.md')).toMatchObject({ status: 'Open', size: '3' });

    install.write('a.md', task('status: Open\nsize: "3"\ndue: 2026-01-05\nowner: "[[Someone]]"\n', 'Edited while Engine was down\n'),
      new Date(Date.now() + 5000));
    install.index();
    expect(install.stored('a.md')).toEqual({ status: 'open', size: 3, due: '2026-01-05', owner: 'Someone', priority: 'normal' });
  });

  it('a note moved while Engine was down is read as the watcher reads it', () => {
    const watched = new Install(1, false);
    try {
      watched.write('Someone.md', '# Someone\n');
      watched.write('r.md', note(['review'], 'other: x\n'));
      watched.watch('a.md', task('status: Open\nsize: "3"\ndue: 2026-01-05\nowner: "[[Someone]]"\n'));
      define(watched.db);
      watched.watch('a.md', task('status: Open\nsize: "3"\ndue: 2026-01-05\nowner: "[[Someone]]"\n'));

      mkdirSync(join(install.vaultPath, 'Moved'));
      renameSync(join(install.vaultPath, 'a.md'), join(install.vaultPath, 'Moved/a.md'));
      expect(install.index()).toMatchObject({ renamed: 1 });
      expect(install.fieldRows('Moved/a.md')).toEqual(watched.fieldRows('a.md'));
      expect(install.stored('Moved/a.md')).toEqual({ status: 'open', size: 3, due: '2026-01-05', owner: 'Someone', priority: 'normal' });
    } finally {
      watched.close();
    }
  });
});
