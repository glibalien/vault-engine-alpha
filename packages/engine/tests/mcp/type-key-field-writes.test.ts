import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb } from '../helpers/db.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { processFileChange } from '../../src/sync/watcher.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { DEFAULT_TYPE_KEY, setTypeKey } from '../../src/parser/type-key.js';
import { sha256 } from '../../src/indexer/hash.js';
import { createTempVault } from '../helpers/vault.js';
import { registerCreateNode } from '../../src/mcp/tools/create-node.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { registerBatchMutate } from '../../src/mcp/tools/batch-mutate.js';
import { registerValidateNode } from '../../src/mcp/tools/validate-node.js';
import { registerUpdateSchema } from '../../src/mcp/tools/update-schema.js';
import { registerUndoOperations } from '../../src/mcp/tools/undo-operations.js';
import { registerVaultDoctor } from '../../src/mcp/tools/vault-doctor.js';

/**
 * The type key (`types`, or the key VAULT_TYPE_KEY designates, #445) holds each note's types,
 * and the renderer writes them under it first. A field of that name would be written over
 * them, so every tool write that takes field names refuses one, naming the parameters that
 * change types on that tool (#480). A field named `types` that a tool write stored before
 * #480 is dropped at the note's next write, with its value kept in the edits log.
 */

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;

type Handler = (args: Record<string, unknown>) => Promise<unknown>;
interface Envelope {
  ok: boolean;
  data?: Record<string, any>;
  error?: { code: string; message: string; details?: Record<string, any> };
  warnings?: Array<{ code: string; field?: string; message: string; severity: string }>;
}

function handler(register: (server: McpServer) => void): Handler {
  let captured: Handler | undefined;
  const fakeServer = {
    tool: (_n: string, _d: string, _s: unknown, h: Handler) => { captured = h; },
    registerTool: (_n: string, _c: unknown, h: Handler) => { captured = h; },
  } as unknown as McpServer;
  register(fakeServer);
  return captured!;
}

const call = async (h: Handler, args: Record<string, unknown>): Promise<Envelope> =>
  JSON.parse(((await h(args)) as { content: Array<{ text: string }> }).content[0].text) as Envelope;

const createNode = (args: Record<string, unknown>) => call(handler(s => registerCreateNode(s, db, writeLock, vaultPath)), args);
const updateNode = (args: Record<string, unknown>) => call(handler(s => registerUpdateNode(s, db, writeLock, vaultPath)), args);
const batch = (args: Record<string, unknown>) => call(handler(s => registerBatchMutate(s, db, writeLock, vaultPath)), args);
const validateNode = (args: Record<string, unknown>) => call(handler(s => registerValidateNode(s, db)), args);
const updateSchema = (args: Record<string, unknown>) => call(handler(s => registerUpdateSchema(s, db, { writeLock, vaultPath })), args);
const undo = (args: Record<string, unknown>) => call(handler(s => registerUndoOperations(s, db, writeLock, vaultPath)), args);
const doctor = () => call(handler(s => registerVaultDoctor(s, db)), {});

/** Every string in a response, so a check finds the refusal wherever the tool reports it. */
const text = (env: unknown): string => JSON.stringify(env).replace(/\\"/g, '"');

const HEAD = (key: string) => `"${key}" is the frontmatter key that holds the note's types, so it cannot be set as a field.`;

/** The refusal is the error's own message, names the key, and points to the tool's types parameters. */
function refusedFor(key: string, env: Envelope, ...params: string[]): void {
  expect(env.ok).toBe(false);
  expect(env.error?.code).toBe('VALIDATION_FAILED');
  expect(env.error?.message.startsWith(HEAD(key))).toBe(true);
  for (const param of params) expect(env.error?.message).toContain(param);
  expect(env.error?.details?.field).toBe(key);
  expect(env.error?.details?.issues?.[0]?.code).toBe('TYPE_KEY_FIELD');
}

function indexNote(file: string, content: string): { id: string; version: number } {
  mkdirSync(join(vaultPath, 'Notes'), { recursive: true });
  writeFileSync(join(vaultPath, file), content, 'utf-8');
  processFileChange(join(vaultPath, file), file, db, writeLock, vaultPath);
  return db.prepare('SELECT id, version FROM nodes WHERE file_path = ?').get(file) as { id: string; version: number };
}

const typesOf = (id: string) => (db.prepare('SELECT schema_type FROM node_types WHERE node_id = ? ORDER BY sort_order').all(id) as
  Array<{ schema_type: string }>).map(row => row.schema_type);
const fieldNamesOf = (id: string) => (db.prepare('SELECT field_name FROM node_fields WHERE node_id = ? ORDER BY field_name').all(id) as
  Array<{ field_name: string }>).map(row => row.field_name);
const removedValues = (id: string) => (db.prepare(
  "SELECT details FROM edits_log WHERE node_id = ? AND event_type = 'value-removed' ORDER BY id",
).all(id) as Array<{ details: string }>).map(row => JSON.parse(row.details) as Record<string, unknown>);
const read = (file: string) => readFileSync(join(vaultPath, file), 'utf8');

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = createTestDb();
  writeLock = new WriteLockManager();
  createSchemaDefinition(db, { name: 'meeting', field_claims: [] });
  createSchemaDefinition(db, { name: 'task', field_claims: [] });
});

afterEach(() => { setTypeKey(DEFAULT_TYPE_KEY); db.close(); cleanup(); });

describe('a field named types under the default key (#480)', () => {
  const before = '---\ntypes:\n  - meeting\nstatus: open\n---\nNotes.\n';

  it('is refused by create-node, dry run or not, pointing to its types parameter', async () => {
    for (const dry_run of [true, false]) {
      const env = await createNode({ title: 'Sync', types: ['meeting'], fields: { types: 'task', status: 'open' }, dry_run });
      refusedFor('types', env, 'Remove "types" from fields', 'create-node\'s types parameter', 'for example types: ["task"]');
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM nodes').get()).toEqual({ n: 0 });
  });

  it('is refused by update-node, set or cleared, dry run or not, and the note keeps its types', async () => {
    const { id } = indexNote('Notes/Sync.md', before);

    for (const dry_run of [true, false]) {
      refusedFor('types', await updateNode({ node_id: id, set_fields: { types: ['task', 'meeting'] }, dry_run }),
        'Remove "types" from set_fields', 'set_types: ["task","meeting"]', 'add_types: ["task","meeting"]', 'remove_types');
      // A null is refused too: it would not clear the types, so the refusal says what does.
      refusedFor('types', await updateNode({ node_id: id, set_fields: { types: null }, dry_run }),
        'to remove types, use remove_types, or set_types: [] to remove them all');
    }
    // Alongside other changes, nothing of the call is applied.
    refusedFor('types', await updateNode({ node_id: id, set_fields: { types: 'task', status: 'done' }, set_body: 'Changed.' }));

    expect(read('Notes/Sync.md')).toBe(before);
    expect(typesOf(id)).toEqual(['meeting']);
    expect(fieldNamesOf(id)).toEqual(['status']);
    // The types parameters still change the types.
    expect((await updateNode({ node_id: id, add_types: ['task'] })).ok).toBe(true);
    expect(typesOf(id)).toEqual(['meeting', 'task']);
  });

  it('is refused by update-node in query mode before any note is read, preview and apply, a null included', async () => {
    const { id } = indexNote('Notes/Sync.md', before);
    const query = { types: ['meeting'] };

    for (const dry_run of [true, false]) {
      refusedFor('types', await updateNode({ query, set_fields: { types: 'task' }, dry_run }),
        'add_types or remove_types', 'query mode has no set_types', 'for example add_types: ["task"]');
      // Not skipped as "nothing to change" on a note without such a field: refused like a value.
      refusedFor('types', await updateNode({ query, set_fields: { types: null }, dry_run }), 'use remove_types');
    }

    expect(read('Notes/Sync.md')).toBe(before);
    expect(typesOf(id)).toEqual(['meeting']);
    expect(db.prepare("SELECT COUNT(*) AS n FROM undo_operations").get()).toEqual({ n: 0 });
  });

  it('is refused by batch-mutate, previewed or applied, and the whole batch rolls back', async () => {
    const { id } = indexNote('Notes/Sync.md', before);
    const operations = [
      { op: 'create', params: { title: 'Other', types: ['task'] } },
      { op: 'update', params: { node_id: id, set_fields: { types: 'task' } } },
    ];

    // A batch preview reports where it would stop, with the refusal.
    const preview = await batch({ operations, dry_run: true });
    expect(preview.data?.failed_at).toBe(1);
    expect(preview.data?.message).toContain(HEAD('types'));
    expect(preview.data?.message).toContain('this update operation\'s set_fields');

    const applied = await batch({ operations });
    expect(applied.ok).toBe(false);
    expect(applied.error?.message).toContain(HEAD('types'));
    expect(applied.error?.message).toContain('set_types: ["task"]');
    expect(applied.error?.details).toMatchObject({ failed_at: 1, op: 'update', issues: [{ code: 'TYPE_KEY_FIELD', field: 'types' }] });

    const create = await batch({ operations: [{ op: 'create', params: { title: 'Other', types: ['task'], fields: { types: 'meeting' } } }] });
    expect(create.error?.message).toContain('this create operation\'s fields');
    expect(create.error?.message).toContain('for example types: ["meeting"]');

    expect(read('Notes/Sync.md')).toBe(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM nodes').get()).toEqual({ n: 1 });
  });

  it('is reported by validate-node for a proposed state', async () => {
    const env = await validateNode({ proposed: { types: ['meeting'], fields: { types: 'task' } } });
    expect(env.data?.valid).toBe(false);
    expect(env.data?.issues).toEqual([expect.objectContaining({ code: 'TYPE_KEY_FIELD', field: 'types' })]);
    expect(env.data?.issues[0].message).toContain('set_types, add_types or remove_types on update-node');
    expect(env.data?.orphan_fields).toEqual([]);
  });

  it('is never a field on the watcher path: the key stays the note\'s types', () => {
    const { id } = indexNote('Notes/Sync.md', before);
    writeFileSync(join(vaultPath, 'Notes/Sync.md'), '---\ntypes: task\nstatus: open\n---\nNotes.\n', 'utf-8');
    processFileChange(join(vaultPath, 'Notes/Sync.md'), 'Notes/Sync.md', db, writeLock, vaultPath);

    expect(typesOf(id)).toEqual(['task']);
    expect(fieldNamesOf(id)).toEqual(['status']);
  });
});

describe('a field named types stored before #480', () => {
  const file = 'Notes/Sync.md';
  /** The file as the old renderer wrote it: the field's value over the note's types. */
  const oldFile = '---\ntypes: legacy\nstatus: open\n---\nNotes.\n';
  const repaired = '---\ntypes:\n  - meeting\nstatus: open\n---\nNotes.\n';

  /** The state a tool write `set_fields: { types: 'legacy' }` left before #480. */
  function seedStaleField(): string {
    const { id } = indexNote(file, '---\ntypes:\n  - meeting\nstatus: open\n---\nNotes.\n');
    db.prepare("INSERT INTO node_fields (node_id, field_name, value_text, source) VALUES (?, 'types', 'legacy', 'frontmatter')").run(id);
    writeFileSync(join(vaultPath, file), oldFile, 'utf-8');
    db.prepare('UPDATE nodes SET content_hash = ? WHERE id = ?').run(sha256(oldFile), id);
    return id;
  }

  function expectDropped(id: string, source: string): void {
    expect(typesOf(id)).toEqual(['meeting']);
    expect(fieldNamesOf(id)).not.toContain('types');
    expect(removedValues(id)).toEqual([expect.objectContaining({ source, field: 'types', removed_value: 'legacy', node_types: typesOf(id) })]);
  }

  it('does not make the note un-editable: the next write drops it, re-renders the types and logs the value', async () => {
    const id = seedStaleField();

    // A dry run shows no refusal for a field the caller did not set.
    const preview = await updateNode({ node_id: id, set_fields: { status: 'done' }, dry_run: true });
    expect(preview.ok).toBe(true);
    expect(text(preview)).not.toContain('TYPE_KEY_FIELD');
    expect(preview.data?.preview.orphan_fields).not.toContain('types');

    const env = await updateNode({ node_id: id, set_fields: { status: 'done' } });
    expect(env.ok, text(env)).toBe(true);
    expect(read(file)).toBe(repaired.replace('open', 'done'));
    expectDropped(id, 'tool');

    // The next write finds nothing more to drop.
    expect((await updateNode({ node_id: id, set_fields: { status: 'open' } })).ok).toBe(true);
    expect(removedValues(id)).toHaveLength(1);
  });

  it('is dropped by a write that changes nothing else, which vault-doctor names as the repair', async () => {
    const id = seedStaleField();
    const found = (await doctor()).data?.invariants.find((i: { name: string }) => i.name === 'type_key_field_values');
    expect(found).toMatchObject({ ok: false, count: 1 });
    expect(found.detail).toContain(file);

    const env = await updateNode({ node_id: id });
    expect(env.ok, text(env)).toBe(true);
    expect(read(file)).toBe(repaired);
    expectDropped(id, 'tool');
    expect((await doctor()).data?.invariants.find((i: { name: string }) => i.name === 'type_key_field_values'))
      .toMatchObject({ ok: true, count: 0 });
  });

  it('is dropped by update-node query mode, preview and apply', async () => {
    const id = seedStaleField();
    const preview = await updateNode({ query: { types: ['meeting'] }, set_fields: { status: 'done' } });
    expect(preview.data).toMatchObject({ would_update: 1, would_fail: 0 });

    const applied = await updateNode({ query: { types: ['meeting'] }, set_fields: { status: 'done' }, dry_run: false });
    expect(applied.data).toMatchObject({ updated: 1, errors: [] });
    expect(read(file)).toBe(repaired.replace('open', 'done'));
    expectDropped(id, 'tool');
  });

  it('is dropped by batch-mutate', async () => {
    const id = seedStaleField();
    const preview = await batch({ operations: [{ op: 'update', params: { node_id: id, set_fields: { status: 'done' } } }], dry_run: true });
    expect(preview.ok, text(preview)).toBe(true);
    expect(preview.data?.failed_at).toBeUndefined();
    expect(fieldNamesOf(id)).toContain('types');

    const env = await batch({ operations: [{ op: 'update', params: { node_id: id, set_fields: { status: 'done' } } }] });
    expect(env.ok, text(env)).toBe(true);
    expectDropped(id, 'tool');
  });

  it('does not block a reference-list member edit', async () => {
    createGlobalField(db, { name: 'related', field_type: 'list', list_item_type: 'reference' });
    expect((await updateSchema({ name: 'meeting', add_field_claims: [{ field: 'related' }] })).ok).toBe(true);
    const id = seedStaleField();
    const other = indexNote('Notes/Other.md', '---\ntypes:\n  - task\n---\n');

    const edit = { node_id: id, reference_edit: { field: 'related', action: 'add', target: { node_id: other.id } } };
    const preview = await updateNode(edit);
    expect(preview.ok, text(preview)).toBe(true);
    const env = await updateNode({ ...edit, dry_run: false });
    expect(env.ok, text(env)).toBe(true);
    expect(read(file)).toBe('---\ntypes:\n  - meeting\nrelated:\n  - "[[Other]]"\nstatus: open\n---\nNotes.\n');
    expectDropped(id, 'tool');
  });

  it('does not block schema propagation: the re-rendered note drops it', async () => {
    const id = seedStaleField();
    createGlobalField(db, { name: 'status', field_type: 'string' });

    const env = await updateSchema({ name: 'meeting', add_field_claims: [{ field: 'status' }] });
    expect(env.ok, text(env)).toBe(true);
    expect(read(file)).toBe(repaired);
    expectDropped(id, 'propagation');
  });

  it('is not restored by undoing the write that dropped it', async () => {
    const id = seedStaleField();
    expect((await updateNode({ node_id: id, set_fields: { status: 'done' } })).ok).toBe(true);
    const { operation_id } = db.prepare('SELECT operation_id FROM undo_operations ORDER BY timestamp DESC LIMIT 1').get() as { operation_id: string };

    const env = await undo({ operation_ids: [operation_id], dry_run: false });
    expect(env.ok, text(env)).toBe(true);
    expect(typesOf(id)).toEqual(['meeting']);
    expect(fieldNamesOf(id)).toEqual(['status']);
    expect(read(file)).toBe(repaired);
    // The undo dropped the snapshot's value again, and says so.
    expect(removedValues(id).map(entry => [entry.source, entry.removed_value])).toEqual([['tool', 'legacy'], ['undo', 'legacy']]);
  });

  it('is not restored with a deleted note by undo, and its value is still logged', async () => {
    const id = seedStaleField();
    const deleted = await batch({ operations: [{ op: 'delete', params: { node_id: id } }] });
    expect(deleted.ok, text(deleted)).toBe(true);
    const { operation_id } = db.prepare('SELECT operation_id FROM undo_operations ORDER BY timestamp DESC LIMIT 1').get() as { operation_id: string };

    const env = await undo({ operation_ids: [operation_id], dry_run: false });
    expect(env.ok, text(env)).toBe(true);
    // The snapshot held the field; the restored note does not, and the value is in the edits log.
    expectDropped(id, 'undo');
    expect(read(file)).toBe(repaired);
  });

  it('records both values when an undo restore carries a different one than the stored row', () => {
    const id = seedStaleField();
    // As an undo of a pre-#480 write that changed the field from `earlier` to `legacy` would.
    executeMutation(db, writeLock, vaultPath, {
      source: 'undo', node_id: id, file_path: file, title: 'Sync', types: ['meeting'],
      fields: { types: 'earlier', status: 'open' }, body: 'Notes.\n', db_only: true,
    });
    expect(fieldNamesOf(id)).toEqual(['status']);
    expect(removedValues(id).map(entry => [entry.source, entry.removed_value])).toEqual([['undo', 'legacy'], ['undo', 'earlier']]);
  });

  it('records a snapshot value an undo restore drops even when nothing else changes', () => {
    // No stored row: as an undo of a pre-#480 write that only cleared the field would restore.
    const { id } = indexNote(file, repaired);
    const before = db.prepare('SELECT version FROM nodes WHERE id = ?').get(id) as { version: number };
    executeMutation(db, writeLock, vaultPath, {
      source: 'undo', node_id: id, file_path: file, title: 'Sync', types: ['meeting'],
      fields: { types: 'earlier', status: 'open' }, body: 'Notes.\n', db_only: true,
    });
    expect(fieldNamesOf(id)).toEqual(['status']);
    expect(read(file)).toBe(repaired);
    expect(db.prepare('SELECT version FROM nodes WHERE id = ?').get(id)).toEqual({ version: before.version + 1 });
    expect(removedValues(id).map(entry => [entry.source, entry.removed_value])).toEqual([['undo', 'earlier']]);
  });

  it('is left out of validate-node\'s check of the note', async () => {
    const id = seedStaleField();
    const env = await validateNode({ node_id: id });
    expect(env.data).toMatchObject({ valid: true, issues: [] });
    expect(env.data?.orphan_fields).not.toContain('types');
  });
});

describe('a field named like a designated type key', () => {
  beforeEach(() => setTypeKey('kind'));

  it('is refused by create-node, and nothing is written', async () => {
    const env = await createNode({ title: 'Sync', types: ['meeting'], fields: { kind: 'task', status: 'open' } });
    refusedFor('kind', env, 'create-node\'s types parameter');
    expect(db.prepare('SELECT COUNT(*) AS n FROM nodes').get()).toEqual({ n: 0 });
  });

  it('is refused by update-node, set or cleared, and the note keeps its types; a field named types is ordinary', async () => {
    const before = '---\nkind:\n  - meeting\nstatus: open\n---\nNotes.\n';
    const { id } = indexNote('Notes/Sync.md', before);

    refusedFor('kind', await updateNode({ node_id: id, set_fields: { kind: 'task' } }), 'set_types');
    refusedFor('kind', await updateNode({ node_id: id, set_fields: { kind: null } }), 'remove_types');

    expect(read('Notes/Sync.md')).toBe(before);
    expect(typesOf(id)).toEqual(['meeting']);
    expect(fieldNamesOf(id)).toEqual(['status']);
    // The types parameters still change the types.
    expect((await updateNode({ node_id: id, add_types: ['task'] })).ok).toBe(true);
    expect(typesOf(id)).toEqual(['meeting', 'task']);
    // Under a designated key, `types` is a field like any other.
    expect((await updateNode({ node_id: id, set_fields: { types: 'legacy' } })).ok).toBe(true);
    expect(fieldNamesOf(id)).toEqual(['status', 'types']);
    expect(read('Notes/Sync.md')).toContain('types: legacy');
  });

  it('is refused by update-node in query mode and by batch-mutate', async () => {
    const before = '---\nkind:\n  - meeting\n---\nNotes.\n';
    const { id } = indexNote('Notes/Sync.md', before);

    refusedFor('kind', await updateNode({ query: { types: ['meeting'] }, set_fields: { kind: 'task' }, dry_run: false }), 'add_types');
    const preview = await batch({ operations: [{ op: 'update', params: { node_id: id, set_fields: { kind: 'task' } } }], dry_run: true });
    expect(preview.data?.message).toContain(HEAD('kind'));

    expect(read('Notes/Sync.md')).toBe(before);
    expect(typesOf(id)).toEqual(['meeting']);
  });

  it('is never a field on the watcher path: the key stays the note\'s types', () => {
    const { id } = indexNote('Notes/Sync.md', '---\nkind:\n  - meeting\nstatus: open\n---\nNotes.\n');
    writeFileSync(join(vaultPath, 'Notes/Sync.md'), '---\nkind: task\nstatus: open\n---\nNotes.\n', 'utf-8');
    processFileChange(join(vaultPath, 'Notes/Sync.md'), 'Notes/Sync.md', db, writeLock, vaultPath);

    expect(typesOf(id)).toEqual(['task']);
    expect(fieldNamesOf(id)).toEqual(['status']);
  });
});
