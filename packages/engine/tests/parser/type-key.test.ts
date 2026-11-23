/**
 * #445: the frontmatter key that holds a note's types is designated at install
 * (VAULT_TYPE_KEY). With nothing configured it is `types`, byte for byte as before.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSchema } from '../../src/db/schema.js';
import { addUndoTables, addUiHints } from '../../src/db/migrate.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { indexFile } from '../../src/indexer/indexer.js';
import { processFileChange } from '../../src/sync/watcher.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { parseFrontmatter, unkeptTypeKeyValues } from '../../src/parser/frontmatter.js';
import { parseMarkdown } from '../../src/parser/parse.js';
import { renderNode } from '../../src/renderer/render.js';
import {
  DEFAULT_TYPE_KEY, isEngineNoteKey, resolveTypeKey, setTypeKey, typeKey, TypeKeyError,
} from '../../src/parser/type-key.js';
import { createGlobalField, renameGlobalField } from '../../src/global-fields/crud.js';
import type { RenderInput } from '../../src/renderer/types.js';
import { renderMemoryNote } from '../../src/memories/note-format.js';
import { createTempVault } from '../helpers/vault.js';

function input(overrides: Partial<RenderInput> = {}): RenderInput {
  return {
    types: ['meeting'],
    fields: { status: 'open' },
    body: 'Notes.\n',
    fieldOrdering: [{ field: 'status', category: 'orphan' }],
    referenceFields: new Set(),
    listReferenceFields: new Set(),
    orphanRawValues: {},
    explicitNullFields: new Set(),
    ...overrides,
  };
}

afterEach(() => setTypeKey(DEFAULT_TYPE_KEY));

describe('the default type key', () => {
  it('is types, rendered first exactly as before', () => {
    expect(typeKey()).toBe('types');
    expect(renderNode(input())).toBe('---\ntypes:\n  - meeting\nstatus: open\n---\nNotes.\n');
    expect(renderNode(input({ types: [] }))).toBe('---\ntypes:\nstatus: open\n---\nNotes.\n');
  });

  it('reads types as a designated key is read (#482): an unquoted [[link]] or a number is a type', () => {
    expect(parseFrontmatter('---\ntypes: [[project]]\n---\n').types).toEqual(['project']);
    expect(parseFrontmatter('---\ntypes:\n  - meeting\n  - [[task]]\n  - 3\n  - true\n---\n').types)
      .toEqual(['meeting', 'task', '3', 'true']);
    expect(parseFrontmatter('---\ntypes:\n  - "[[project|Projects]]"\n  - project\n---\n').types).toEqual(['project']);
    // Rendered back, the value is still there, as a list.
    const parsed = parseMarkdown('---\ntypes: [[project]]\n---\nBody.\n', 'Projects/Alpha.md');
    expect(renderNode(input({ types: parsed.types, fields: {}, fieldOrdering: [], body: parsed.body })))
      .toBe('---\ntypes:\n  - project\n---\nBody.\n');
  });

  it('reads no type from a mapping or a deeper list under types, as before (#482)', () => {
    // Today's result, kept: the value is no type, and the other items still are.
    expect(parseFrontmatter('---\ntypes:\n  category: meeting\n---\n').types).toEqual([]);
    expect(parseFrontmatter('---\ntypes:\n  - task\n  - [a, b]\n  - category: x\n---\n').types).toEqual(['task']);
    expect(parseFrontmatter('---\ntypes: [[[[project]]]]\n---\n').types).toEqual([]);
    expect(parseFrontmatter('---\ntypes: [[a, b]]\n---\n').types).toEqual([]);
    expect(parseFrontmatter('---\ntypes:\n---\n').types).toEqual([]);
    expect(parseFrontmatter('---\ntypes: [[]]\n---\n').types).toEqual([]);
    // Neither is it a field: `types` is the type key.
    expect(parseFrontmatter('---\ntypes:\n  category: meeting\n---\n').fields.size).toBe(0);
  });

  it('reads types from types, and kind stays a field', () => {
    const parsed = parseFrontmatter('---\ntypes:\n  - meeting\nkind: call\n---\n');
    expect(parsed.types).toEqual(['meeting']);
    expect([...parsed.fields.entries()]).toEqual([['kind', 'call']]);
  });
});

describe('a designated type key', () => {
  beforeEach(() => setTypeKey('kind'));

  it('renders the types under it, first, and no types key', () => {
    expect(renderNode(input())).toBe('---\nkind:\n  - meeting\nstatus: open\n---\nNotes.\n');
    expect(renderNode(input({ types: [] }))).toBe('---\nkind:\nstatus: open\n---\nNotes.\n');
  });

  it('parses types from it, a scalar or a [[link]] too, and keeps a types key as a field', () => {
    expect(parseFrontmatter('---\nkind: meeting\n---\n').types).toEqual(['meeting']);
    expect(parseFrontmatter('---\nkind:\n  - "[[meeting]]"\n  - task\n---\n').types).toEqual(['meeting', 'task']);
    const parsed = parseFrontmatter('---\nkind:\n  - meeting\ntypes:\n  - legacy\n---\n');
    expect(parsed.types).toEqual(['meeting']);
    expect([...parsed.fields.entries()]).toEqual([['types', ['legacy']]]);
  });

  it('keeps every value the key held: unquoted [[links]], as the Analyzer reads them, and numbers', () => {
    expect(parseFrontmatter('---\nkind: [[project]]\n---\n').types).toEqual(['project']);
    expect(parseFrontmatter('---\nkind:\n  - "[[meeting]]"\n  - [[task]]\n  - 3\n  - true\n---\n').types)
      .toEqual(['meeting', 'task', '3', 'true']);
    // Rendered back, the value is still there.
    const parsed = parseMarkdown('---\nkind: [[project]]\n---\nBody.\n', 'Projects/Alpha.md');
    expect(renderNode(input({ types: parsed.types, fields: {}, fieldOrdering: [], body: parsed.body })))
      .toBe('---\nkind:\n  - project\n---\nBody.\n');
  });

  it('reads a link with an alias as its target and a type held twice as one, as the Analyzer does', () => {
    expect(parseFrontmatter('---\nkind: [[project|Projects]]\n---\n').types).toEqual(['project']);
    expect(parseFrontmatter('---\nkind:\n  - "[[meeting|Meetings]]"\n  - [[task | Tasks]]\n---\n').types).toEqual(['meeting', 'task']);
    expect(parseFrontmatter('---\nkind: [project, project, "[[project]]"]\n---\n').types).toEqual(['project']);
    expect(parseFrontmatter('---\nkind: [3, "3"]\n---\n').types).toEqual(['3']);
    // types reads the same way (#482).
    setTypeKey('types');
    expect(parseFrontmatter('---\ntypes:\n  - "[[project|Projects]]"\n---\n').types).toEqual(['project']);
  });

  it('names the values it cannot keep, which the Analyzer refuses to designate', () => {
    expect(unkeptTypeKeyValues('meeting')).toEqual([]);
    expect(unkeptTypeKeyValues([['project']])).toEqual([]);
    expect(unkeptTypeKeyValues(['task', [['meeting']], 3, null])).toEqual([]);
    expect(unkeptTypeKeyValues({ category: 'meeting' })).toEqual([{ category: 'meeting' }]);
    expect(unkeptTypeKeyValues(['task', ['a', 'b']])).toEqual([['a', 'b']]);
  });

  it('round-trips a rendered note through the parser', () => {
    const rendered = renderNode(input({ types: ['meeting', 'task'] }));
    const parsed = parseMarkdown(rendered, 'Notes/Sync.md');
    expect(parsed.types).toEqual(['meeting', 'task']);
    expect(parsed.fields.get('status')).toBe('open');
    expect(parsed.fields.has('kind')).toBe(false);
  });
});

describe('Engine\'s own notes with a designated type key', () => {
  it('render the memory note with it', () => {
    setTypeKey('kind');
    const note = renderMemoryNote([], []);
    expect(note.bytes.startsWith('---\nkind:\n')).toBe(true);
    expect(note.bytes).not.toMatch(/^types:/m);
    setTypeKey(DEFAULT_TYPE_KEY);
    expect(renderMemoryNote([], []).bytes.startsWith('---\ntypes:\n')).toBe(true);
  });
});

describe('indexing and saving with a designated type key', () => {
  let vaultPath: string; let cleanup: () => void;
  let db: Database.Database; let writeLock: WriteLockManager;

  beforeEach(() => {
    setTypeKey('kind');
    ({ vaultPath, cleanup } = createTempVault());
    db = new Database(':memory:'); createSchema(db); addUndoTables(db); addUiHints(db);
    writeLock = new WriteLockManager();
  });
  afterEach(() => { db.close(); cleanup(); });

  const typesOf = (id: string) => (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ? ORDER BY schema_type').all(id) as
    Array<{ schema_type: string }>).map(row => row.schema_type);
  const fieldsOf = (id: string) => (db.prepare('SELECT field_name FROM node_fields WHERE node_id = ? ORDER BY field_name').all(id) as
    Array<{ field_name: string }>).map(row => row.field_name);

  it('indexes the key as types, writes them back under it, and the watcher reads the save', () => {
    mkdirSync(join(vaultPath, 'Meetings'), { recursive: true });
    const abs = join(vaultPath, 'Meetings', 'Sync.md');
    writeFileSync(abs, '---\nkind: meeting\nstatus: open\nowner: "[[Ann]]"\ntypes: legacy\n---\nNotes.\n');

    const id = indexFile(abs, vaultPath, db);
    expect(typesOf(id)).toEqual(['meeting']);
    expect(fieldsOf(id)).toEqual(['owner', 'status', 'types']);

    executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: id, file_path: 'Meetings/Sync.md', title: 'Sync', types: ['meeting', 'task'],
      fields: { status: 'done', owner: '[[Ann]]', types: 'legacy' }, body: 'Notes.\n',
    });
    const written = readFileSync(abs, 'utf8');
    expect(written.startsWith('---\nkind:\n  - meeting\n  - task\n')).toBe(true);
    expect(written).toContain('owner: "[[Ann]]"');
    expect(written).toContain('types: legacy');

    // An edit on disk, read by the watcher.
    writeFileSync(abs, written.replace('  - task\n', ''));
    processFileChange(abs, 'Meetings/Sync.md', db, writeLock, vaultPath);
    expect(typesOf(id)).toEqual(['meeting']);
    expect(fieldsOf(id)).toEqual(['owner', 'status', 'types']);
  });

  it('indexes a note whose key holds a type twice', () => {
    mkdirSync(join(vaultPath, 'Projects'), { recursive: true });
    const abs = join(vaultPath, 'Projects', 'Alpha.md');
    writeFileSync(abs, '---\nkind: [project, "[[project|Projects]]"]\n---\nPlan.\n');

    const id = indexFile(abs, vaultPath, db);
    expect(typesOf(id)).toEqual(['project']);
  });

  it('refuses a global field named like the type key, created or renamed to it', () => {
    expect(() => createGlobalField(db, { name: 'kind', field_type: 'string' }))
      .toThrow("'kind' is the frontmatter key that holds a note's types, so it cannot be a global field");
    createGlobalField(db, { name: 'category', field_type: 'string' });
    expect(() => renameGlobalField(db, 'category', 'kind')).toThrow(/frontmatter key that holds a note's types/);
    // types is an ordinary name once another key holds the types.
    expect(createGlobalField(db, { name: 'types', field_type: 'string' }).name).toBe('types');
  });
});

describe('resolveTypeKey (VAULT_TYPE_KEY)', () => {
  it('defaults to types when unset or blank, and trims', () => {
    expect(resolveTypeKey(undefined)).toBe('types');
    expect(resolveTypeKey('  ')).toBe('types');
    expect(resolveTypeKey(' kind ')).toBe('kind');
    expect(resolveTypeKey('note type')).toBe('note type');
  });

  it('refuses a key on more than one line', () => {
    expect(() => resolveTypeKey('ki\nnd')).toThrow(TypeKeyError);
  });

  it.each(['source', 'model', 'provider', 'aliases', 'wiki_kind', 'projectType', 'excludeDirs', 'statusOpen', 'vault_engine_projection'])(
    'refuses %s, a key Engine writes in its own notes',
    (key) => {
      expect(isEngineNoteKey(key)).toBe(true);
      expect(() => resolveTypeKey(key)).toThrow(`VAULT_TYPE_KEY cannot be "${key}"`);
    },
  );

  it('accepts ordinary keys', () => {
    for (const key of ['types', 'type', 'kind', 'category']) expect(isEngineNoteKey(key)).toBe(false);
  });
});
