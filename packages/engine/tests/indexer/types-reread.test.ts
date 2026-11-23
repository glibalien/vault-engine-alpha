/**
 * #482: `types` reads its values as a designated type key does. A note an older Engine
 * indexed with the narrower reading is read again once, at the first start, from its
 * unchanged file: it gains its types, nothing else about it changes, and no file is written.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createTestDb } from '../helpers/db.js';
import { fullIndex } from '../../src/indexer/indexer.js';
import { backfillResolvedTargets } from '../../src/resolver/refresh.js';
import { rereadTypeKeyValues, typesRereadLog, TYPES_REREAD_EVENT, TYPES_REREAD_META_KEY } from '../../src/indexer/types-reread.js';
import { getMeta } from '../../src/db/meta.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { processFileChange } from '../../src/sync/watcher.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';

/** Notes as a person wrote them; none has been saved by Engine except Saved.md. */
const NOTES: Record<string, string> = {
  // An unquoted [[link]]: YAML's nested list.
  'Projects/Alpha.md': '---\ntypes: [[project]]\nstatus: active\ncount: "3"\nowner: "[[Ann Example]]"\n---\nThe plan, with [[Beta]].\n',
  // Its claimed status is not one of the schema's values: the index keeps it anyway.
  'Projects/Beta.md': '---\ntypes: [[project]]\nstatus: someday\n---\nLater.\n',
  // A list item of that form beside a plain one.
  'Meetings/Sync.md': '---\ntypes:\n  - meeting\n  - [[task]]\nwhen: 6 March 2020\n---\nNotes.\n',
  'Numbers.md': '---\ntypes:\n  - 3\n  - true\n---\n',
  'Aliased.md': '---\ntypes:\n  - "[[project|Projects]]"\n---\n',
  // A type without a schema.
  'Ghost.md': '---\ntypes: [[ghost]]\n---\n',
  // Still no type under any key: a mapping, a deeper list.
  'Mapping.md': '---\ntypes:\n  category: meeting\n---\n',
  'Deeper.md': '---\ntypes: [[a, b]]\n---\n',
  'Plain.md': '---\ntypes:\n  - meeting\n---\n',
  // Saved by Engine already: its line is empty, nothing to recover.
  'Saved.md': '---\ntypes:\nstatus: open\n---\n',
  'People/Ann Example.md': '---\ntypes:\n  - person\n---\n',
  'Broken.md': '---\ntypes: [[project]\n---\n',
};

/** What the previous Engine stored for each: string items only, a quoted whole link without its brackets. */
const PREVIOUS_TYPES: Record<string, string[]> = {
  'Projects/Alpha.md': [],
  'Projects/Beta.md': [],
  'Meetings/Sync.md': ['meeting'],
  'Numbers.md': [],
  'Aliased.md': ['project|Projects'],
  'Ghost.md': [],
  'Mapping.md': [],
  'Deeper.md': [],
  'Plain.md': ['meeting'],
  'Saved.md': [],
  'People/Ann Example.md': ['person'],
  'Broken.md': [],
};

let vault: string;
let db: Database.Database;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'types-reread-'));
  for (const [path, content] of Object.entries(NOTES)) {
    mkdirSync(dirname(join(vault, path)), { recursive: true });
    writeFileSync(join(vault, path), content);
  }
  db = createTestDb();
  createGlobalField(db, { name: 'status', field_type: 'enum', enum_values: ['open', 'active', 'done'] });
  createGlobalField(db, { name: 'count', field_type: 'number' });
  for (const name of ['meeting', 'task', 'person']) createSchemaDefinition(db, { name, field_claims: [] });
  createSchemaDefinition(db, { name: 'project', field_claims: [{ field: 'status' }, { field: 'count' }] });
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  rmSync(vault, { recursive: true, force: true });
});

const idOf = (path: string) => (db.prepare('SELECT id FROM nodes WHERE file_path = ?').get(path) as { id: string }).id;
const typesOf = (path: string) => (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ? ORDER BY sort_order').all(idOf(path)) as
  Array<{ schema_type: string }>).map(row => row.schema_type);

/** The database as the previous Engine left it: its narrower types, indexed at an earlier start. */
function indexAsPreviousEngine(): void {
  fullIndex(vault, db);
  backfillResolvedTargets(db); // as every start does after its index
  const insert = db.prepare('INSERT INTO node_types (node_id, schema_type, sort_order) VALUES (?, ?, ?)');
  db.transaction(() => {
    for (const [path, types] of Object.entries(PREVIOUS_TYPES)) {
      db.prepare('DELETE FROM node_types WHERE node_id = ?').run(idOf(path));
      types.forEach((type, i) => insert.run(idOf(path), type, i));
    }
    db.prepare('UPDATE nodes SET indexed_at = indexed_at - 60000').run();
  })();
}

/** Everything a reader sees of the notes, but their types and when they were indexed. */
function stateBesideTypes() {
  return {
    nodes: db.prepare('SELECT id, file_path, title, body, content_hash, file_mtime, content_changed_at, created_at, version FROM nodes ORDER BY file_path').all(),
    fields: db.prepare('SELECT * FROM node_fields ORDER BY node_id, field_name').all(),
    relationships: db.prepare('SELECT source_id, target, rel_type, context, resolved_target_id FROM relationships ORDER BY source_id, target, rel_type').all(),
    explicitNulls: db.prepare('SELECT * FROM node_explicit_null_fields ORDER BY node_id, field_name').all(),
  };
}

function files(): Record<string, { content: string; mtime: number }> {
  return Object.fromEntries(Object.keys(NOTES).map(path => [path, {
    content: readFileSync(join(vault, path), 'utf8'), mtime: statSync(join(vault, path)).mtimeMs,
  }]));
}

describe('the first start after the reading of types changed (#482)', () => {
  it('reads again the notes whose types now read otherwise; nothing else changes and no file is written', () => {
    indexAsPreviousEngine();
    const before = stateBesideTypes();
    const filesBefore = files();

    // The start: the index skips every unchanged file, then the one-time check.
    const since = Date.now();
    expect(fullIndex(vault, db)).toMatchObject({ indexed: 0, deleted: 0 });
    const reread = rereadTypeKeyValues(vault, db, since);

    expect(reread).toEqual([
      { file_path: 'Aliased.md', before: ['project|Projects'], after: ['project'] },
      { file_path: 'Ghost.md', before: [], after: ['ghost'] },
      { file_path: 'Meetings/Sync.md', before: ['meeting'], after: ['meeting', 'task'] },
      { file_path: 'Numbers.md', before: [], after: ['3', 'true'] },
      { file_path: 'Projects/Alpha.md', before: [], after: ['project'] },
      { file_path: 'Projects/Beta.md', before: [], after: ['project'] },
    ]);
    expect(typesOf('Projects/Alpha.md')).toEqual(['project']);
    expect(typesOf('Meetings/Sync.md')).toEqual(['meeting', 'task']);
    // Today's result kept for what is still no type, and for a note already saved.
    for (const path of ['Mapping.md', 'Deeper.md', 'Saved.md', 'Broken.md']) expect(typesOf(path)).toEqual([]);
    expect(typesOf('Plain.md')).toEqual(['meeting']);

    // Nothing else: fields as written (no default, no coercion, an off-list status kept),
    // links, titles, versions; and every file byte for byte, mtime too.
    expect(stateBesideTypes()).toEqual(before);
    expect(files()).toEqual(filesBefore);

    // Listed in the edits log and the start log.
    const logged = db.prepare('SELECT node_id, details FROM edits_log WHERE event_type = ? ORDER BY id').all(TYPES_REREAD_EVENT) as
      Array<{ node_id: string; details: string }>;
    expect(logged.map(row => JSON.parse(row.details))).toEqual(reread);
    expect(logged[0]?.node_id).toBe(idOf('Aliased.md'));
    const lines = typesRereadLog(reread);
    expect(lines[0]).toContain('[types] 6 note(s) read again');
    expect(lines).toContain('[types]   Projects/Alpha.md: (none) -> project');
    expect(lines).toContain('[types]   Aliased.md: project|Projects -> project');

    // Once per database.
    expect(getMeta(db, TYPES_REREAD_META_KEY)).not.toBeNull();
    expect(rereadTypeKeyValues(vault, db, Date.now())).toBeNull();
    expect(typesRereadLog(null)).toEqual([]);
  });

  it('then writes the types as a list at the note\'s next save, which validates its claimed fields', () => {
    indexAsPreviousEngine();
    rereadTypeKeyValues(vault, db, Date.now());
    const id = idOf('Projects/Alpha.md');
    const fields = Object.fromEntries((db.prepare('SELECT field_name, value_text, value_number FROM node_fields WHERE node_id = ?').all(id) as
      Array<{ field_name: string; value_text: string | null; value_number: number | null }>)
      .map(row => [row.field_name, row.value_number ?? row.value_text]));
    // Read again as the watcher reads the file (#515): the claimed count is stored as a number.
    expect(fields).toEqual({ status: 'active', count: 3, owner: 'Ann Example' });

    executeMutation(db, new WriteLockManager(), vault, {
      source: 'tool', node_id: id, file_path: 'Projects/Alpha.md', title: 'Alpha',
      types: typesOf('Projects/Alpha.md'), fields: { ...fields, status: 'done' }, body: 'The plan, with [[Beta]].\n',
    });

    const written = readFileSync(join(vault, 'Projects/Alpha.md'), 'utf8');
    expect(written.startsWith('---\ntypes:\n  - project\n')).toBe(true);
    expect(written).toContain('status: done');
    expect(written).toContain('count: 3\n'); // a project's count is a number now
    expect(written).toContain('owner: "[[Ann Example]]"');
  });

  it('checks nothing on a new database, and skips a file changed since it was indexed', () => {
    const since = Date.now();
    fullIndex(vault, db);
    expect(rereadTypeKeyValues(vault, db, since)).toEqual([]);
    expect(getMeta(db, TYPES_REREAD_META_KEY)).not.toBeNull();

    db.prepare('DELETE FROM meta WHERE key = ?').run(TYPES_REREAD_META_KEY);
    indexAsPreviousEngine();
    // Changed on disk with its mtime kept, so the start's index did not read it.
    const abs = join(vault, 'Projects/Alpha.md');
    const { atime, mtime } = statSync(abs);
    writeFileSync(abs, NOTES['Projects/Alpha.md']!.replace('active', 'done'));
    utimesSync(abs, atime, mtime);
    const reread = rereadTypeKeyValues(vault, db, Date.now());
    expect(reread?.map(note => note.file_path)).not.toContain('Projects/Alpha.md');
    expect(typesOf('Projects/Alpha.md')).toEqual([]);
  });
});

describe('a note that fails to index again', () => {
  it('keeps its stored state, is named in the log, and the others are still read', () => {
    indexAsPreviousEngine();
    db.exec(`CREATE TRIGGER fail_ghost BEFORE INSERT ON node_types WHEN NEW.schema_type = 'ghost'
      BEGIN SELECT RAISE(ABORT, 'refused'); END`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const reread = rereadTypeKeyValues(vault, db, Date.now());

    expect(reread?.map(note => note.file_path)).not.toContain('Ghost.md');
    expect(reread?.map(note => note.file_path)).toContain('Projects/Alpha.md');
    expect(typesOf('Ghost.md')).toEqual([]);
    expect(warn).toHaveBeenCalledWith('[types] could not read Ghost.md again: refused');
    expect(getMeta(db, TYPES_REREAD_META_KEY)).not.toBeNull();
  });
});

describe('a type without a schema read from an unquoted link (#482)', () => {
  it('is indexed by the watcher with no error', () => {
    const errors = vi.spyOn(console, 'error');
    fullIndex(vault, db);
    writeFileSync(join(vault, 'Phantom.md'), '---\ntypes: [[phantom]]\n---\nA note.\n');
    processFileChange(join(vault, 'Phantom.md'), 'Phantom.md', db, new WriteLockManager(), vault);
    expect(typesOf('Phantom.md')).toEqual(['phantom']);
    expect(typesOf('Ghost.md')).toEqual(['ghost']);
    expect(errors).not.toHaveBeenCalled();
  });
});
