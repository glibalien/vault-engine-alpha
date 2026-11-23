// Schema files stay in .schemas/ (#473): a new schema can't be given a name that is a path,
// and a schema that already has one keeps working without Engine touching files elsewhere.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition, getSchemaDefinition } from '../../src/schema/crud.js';
import { isSchemaName, schemaNameProblem } from '../../src/schema/name.js';
import { deleteSchemaFile, renderFieldsFile, renderSchemaFile, schemaFilePath, startupSchemaRender } from '../../src/schema/render.js';
import { sha256 } from '../../src/indexer/hash.js';
import { registerCreateSchema } from '../../src/mcp/tools/create-schema.js';
import { registerUpdateSchema } from '../../src/mcp/tools/update-schema.js';
import { registerDeleteSchema } from '../../src/mcp/tools/delete-schema.js';
import { registerRenameGlobalField } from '../../src/mcp/tools/rename-global-field.js';
import { createOperation, finalizeOperation } from '../../src/undo/operation.js';
import { captureSchemaSnapshot } from '../../src/undo/schema-snapshot.js';
import { restoreMany } from '../../src/undo/restore.js';
import { ensureWikiSchema } from '../../src/wiki/bootstrap.js';
import { getWikiConfig } from '../../src/wiki/config.js';
import { setStoredSettings } from '../../src/settings/store.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { SyncLogger } from '../../src/sync/sync-logger.js';

interface Envelope { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string }; warnings: Array<{ code: string }> }
type Handler = (args: Record<string, unknown>) => Promise<Envelope>;

let db: Database.Database;
let vaultPath: string;
let cleanup: () => void;
let writeLock: WriteLockManager;
let outsideVault: string[];

function parse(result: unknown): Envelope {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0].text) as Envelope;
}

function capture(register: (server: McpServer) => void): Handler {
  let handler: ((args: Record<string, unknown>) => unknown) | undefined;
  const take = (...args: unknown[]) => { handler = args[args.length - 1] as (a: Record<string, unknown>) => unknown; };
  register({ registerTool: take, tool: take } as unknown as McpServer);
  return async args => parse(await handler!(args));
}

const createSchemaTool = () => capture(server => registerCreateSchema(server, db, { vaultPath }));
const updateSchemaTool = () => capture(server => registerUpdateSchema(server, db, { writeLock, vaultPath, syncLogger: new SyncLogger(db) }));
const deleteSchemaTool = () => capture(server => registerDeleteSchema(server, db, { vaultPath }));
const renameFieldTool = () => capture(server => registerRenameGlobalField(server, db, { writeLock, vaultPath, syncLogger: new SyncLogger(db) }));

/** A schema row as an older Engine could have stored it, without today's name check. */
function insertLegacySchema(name: string): void {
  db.prepare("INSERT INTO schemas (name, field_claims) VALUES (?, '[]')").run(name);
}

/** A name that points one folder above the vault, unique so parallel runs don't meet. */
function aboveVaultName(): { name: string; file: string } {
  const base = `escape-473-${randomUUID()}`;
  const file = join(vaultPath, '..', `${base}.yaml`);
  outsideVault.push(file);
  return { name: `../../${base}`, file };
}

function blockedEntries(eventType: string): Array<Record<string, unknown>> {
  return (db.prepare('SELECT details FROM edits_log WHERE event_type = ?').all(eventType) as Array<{ details: string }>)
    .map(row => JSON.parse(row.details) as Record<string, unknown>);
}

beforeEach(() => {
  ({ vaultPath, cleanup } = createTempVault());
  db = createTestDb();
  writeLock = new WriteLockManager();
  outsideVault = [];
  createGlobalField(db, { name: 'status', field_type: 'string' });
});

afterEach(() => {
  db.close();
  cleanup();
  for (const file of outsideVault) rmSync(file, { force: true });
});

const ODD_BUT_LEGAL = ['Meeting Notes', 'café', '会议', 'v1.2', '.hidden', 'notes.yaml.old', 'C++', 'Q&A', 'note (old)', '...', 'a:b'];
const REFUSED = ['a/b', '../outside', '../Notes/x', '../../outside', 'a\\b', '..\\x', '.', '..', '_fields', '_internal'];

describe('isSchemaName', () => {
  it('accepts names with spaces, unicode and dots inside', () => {
    for (const name of ODD_BUT_LEGAL) expect([name, isSchemaName(name)]).toEqual([name, true]);
  });

  it('refuses a slash or backslash, "." and "..", and a leading "_", saying which and why', () => {
    for (const name of REFUSED) expect([name, isSchemaName(name)]).toEqual([name, false]);
    const message = schemaNameProblem('../outside')!;
    expect(message).toContain('"../outside"');
    for (const part of ['"/"', '"\\"', '"." or ".."', '"_"', '.schemas/', '_fields.yaml']) expect(message).toContain(part);
    expect(schemaNameProblem('Meeting Notes')).toBeNull();
  });
});

describe('creating a schema', () => {
  it('create-schema refuses every name with a path part or a reserved name, writing nothing anywhere', async () => {
    const create = createSchemaTool();
    const above = aboveVaultName();
    for (const name of [...REFUSED, above.name]) {
      const out = await create({ name, field_claims: [{ field: 'status' }] });
      expect([name, out.ok, out.error?.code]).toEqual([name, false, 'INVALID_PARAMS']);
      expect(out.error?.message).toContain('can\'t contain "/" or "\\"');
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM schemas').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM undo_operations').get()).toEqual({ n: 0 });
    expect(existsSync(above.file)).toBe(false);
    expect(existsSync(join(vaultPath, 'outside.yaml'))).toBe(false);
    expect(existsSync(join(vaultPath, 'Notes', 'x.yaml'))).toBe(false);
    expect(existsSync(join(vaultPath, '.schemas', 'a'))).toBe(false);
    expect(existsSync(join(vaultPath, '.schemas', '_fields.yaml'))).toBe(false);
  });

  it('createSchemaDefinition refuses the same names, so the wiki and transcript kinds are covered too', () => {
    for (const name of REFUSED) {
      expect(() => createSchemaDefinition(db, { name, field_claims: [] })).toThrow(/can't be used/);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM schemas').get()).toEqual({ n: 0 });
  });

  it('the wiki kind is refused before any wiki field or schema is created', () => {
    setStoredSettings(db, 'vault', { wikiType: '../outside' });
    expect(() => ensureWikiSchema(db, getWikiConfig(db))).toThrow(/Schema name "\.\.\/outside" can't be used/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM schemas').get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM global_fields WHERE name LIKE 'wiki_%'").get()).toEqual({ n: 0 });
  });

  it('create-schema keeps every odd-but-legal name, each in its own file in .schemas/, and undo removes it', async () => {
    const create = createSchemaTool();
    for (const name of ODD_BUT_LEGAL) {
      const out = await create({ name, field_claims: [{ field: 'status' }] });
      expect([name, out.ok]).toEqual([name, true]);
      const file = join(vaultPath, '.schemas', `${name}.yaml`);
      expect(readFileSync(file, 'utf8')).toContain('field: status');
      restoreMany(db, writeLock, vaultPath, { operation_ids: [out.data!.operation_id as string], dry_run: false });
      expect(getSchemaDefinition(db, name)).toBeNull();
      expect(existsSync(file)).toBe(false);
    }
  });
});

describe('startup', () => {
  it('re-renders a missing file for every odd-but-legal name, dots and ".yaml" inside the name included', () => {
    for (const name of ODD_BUT_LEGAL) createSchemaDefinition(db, { name, field_claims: [{ field: 'status' }] });
    startupSchemaRender(db, vaultPath);
    for (const name of ODD_BUT_LEGAL) rmSync(join(vaultPath, '.schemas', `${name}.yaml`));

    startupSchemaRender(db, vaultPath);

    for (const name of ODD_BUT_LEGAL) {
      expect([name, readFileSync(join(vaultPath, '.schemas', `${name}.yaml`), 'utf8')]).toEqual([name, expect.stringContaining('field: status')]);
    }
  });
});

describe('schemaFilePath', () => {
  it('is the file in .schemas/ for any contained name, and null outside it or over _fields.yaml', () => {
    expect(schemaFilePath(vaultPath, 'task')).toBe(join(vaultPath, '.schemas', 'task.yaml'));
    expect(schemaFilePath(vaultPath, 'a/b')).toBe(join(vaultPath, '.schemas', 'a', 'b.yaml'));
    expect(schemaFilePath(vaultPath, '.')).toBe(join(vaultPath, '.schemas', '..yaml'));
    for (const name of ['../outside', '../Notes/x', '../../outside', 'a/../../outside', '_fields', '_FIELDS', 'a/../_fields']) {
      expect([name, schemaFilePath(vaultPath, name)]).toEqual([name, null]);
    }
  });
});

describe('a schema that already has a name outside .schemas/', () => {
  const legacy = ['../outside', '../Notes/x', '_fields'];

  it('renders no file outside .schemas/ and leaves _fields.yaml alone, logging why', () => {
    renderFieldsFile(db, vaultPath);
    const pool = readFileSync(join(vaultPath, '.schemas', '_fields.yaml'), 'utf8');
    const above = aboveVaultName();
    for (const name of [...legacy, above.name]) {
      insertLegacySchema(name);
      expect([name, renderSchemaFile(db, vaultPath, name)]).toEqual([name, false]);
    }
    expect(existsSync(join(vaultPath, 'outside.yaml'))).toBe(false);
    expect(existsSync(join(vaultPath, 'Notes', 'x.yaml'))).toBe(false);
    expect(existsSync(above.file)).toBe(false);
    expect(readFileSync(join(vaultPath, '.schemas', '_fields.yaml'), 'utf8')).toBe(pool);
    expect(blockedEntries('schema-file-render-blocked')).toEqual([...legacy, above.name].map(name => expect.objectContaining({
      file_path: `.schemas/${name}.yaml`, reason: 'outside-schemas-dir',
    })));
    expect(db.prepare("SELECT COUNT(*) AS n FROM schema_file_hashes WHERE file_path != '.schemas/_fields.yaml'").get()).toEqual({ n: 0 });
  });

  it('still updates through update-schema, with the export reported blocked and nothing written outside', async () => {
    const update = updateSchemaTool();
    for (const name of legacy) {
      insertLegacySchema(name);
      const out = await update({ name, display_name: 'Renamed', field_claims: [{ field: 'status' }] });
      expect([name, out.ok]).toEqual([name, true]);
      expect(out.warnings.map(w => w.code)).toContain('SCHEMA_FILE_RENDER_BLOCKED');
      expect(getSchemaDefinition(db, name)?.display_name).toBe('Renamed');
    }
    expect(existsSync(join(vaultPath, 'outside.yaml'))).toBe(false);
    expect(existsSync(join(vaultPath, 'Notes', 'x.yaml'))).toBe(false);
    expect(existsSync(join(vaultPath, '.schemas', '_fields.yaml'))).toBe(false);
  });

  it('is re-rendered by a global-field rename without writing outside .schemas/', async () => {
    insertLegacySchema('../outside');
    db.prepare("INSERT INTO schema_field_claims (schema_name, field, sort_order) VALUES ('../outside', 'status', 1000)").run();
    const out = await renameFieldTool()({ old_name: 'status', new_name: 'state' });
    expect(out.ok).toBe(true);
    expect(existsSync(join(vaultPath, 'outside.yaml'))).toBe(false);
    expect(readFileSync(join(vaultPath, '.schemas', '_fields.yaml'), 'utf8')).toContain('name: state');
  });

  it('is deleted by delete-schema, leaving the file it wrote before untouched', async () => {
    const above = aboveVaultName();
    for (const [name, file] of [['../outside', join(vaultPath, 'outside.yaml')], [above.name, above.file]] as const) {
      insertLegacySchema(name);
      writeFileSync(file, 'name: old export\n');
      db.prepare('INSERT INTO schema_file_hashes (file_path, content_hash, rendered_at) VALUES (?, ?, ?)')
        .run(`.schemas/${name}.yaml`, sha256('name: old export\n'), Date.now());
      const out = await deleteSchemaTool()({ name });
      expect([name, out.ok]).toEqual([name, true]);
      expect(getSchemaDefinition(db, name)).toBeNull();
      expect(readFileSync(file, 'utf8')).toBe('name: old export\n');
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_file_hashes').get()).toEqual({ n: 0 });
    expect(blockedEntries('schema-file-delete-blocked')).toHaveLength(2);
  });

  it('deleteSchemaFile never deletes _fields.yaml for a schema named _fields', () => {
    renderFieldsFile(db, vaultPath);
    insertLegacySchema('_fields');
    expect(deleteSchemaFile(db, vaultPath, '_fields')).toBe(false);
    expect(existsSync(join(vaultPath, '.schemas', '_fields.yaml'))).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM schema_file_hashes WHERE file_path = '.schemas/_fields.yaml'").get()).toEqual({ n: 1 });
  });

  it('is neither re-created nor read at startup from an export recorded before', () => {
    insertLegacySchema('../outside');
    insertLegacySchema('../Notes/x');
    db.prepare('INSERT INTO schema_file_hashes (file_path, content_hash, rendered_at) VALUES (?, ?, ?)')
      .run('.schemas/../outside.yaml', sha256('name: old export\n'), Date.now());
    db.prepare('INSERT INTO schema_file_hashes (file_path, content_hash, rendered_at) VALUES (?, ?, ?)')
      .run('.schemas/../Notes/x.yaml', sha256('name: old export\n'), Date.now());
    mkdirSync(join(vaultPath, 'Notes'), { recursive: true });
    writeFileSync(join(vaultPath, 'Notes', 'x.yaml'), 'someone else\'s file\n');

    startupSchemaRender(db, vaultPath);

    expect(existsSync(join(vaultPath, 'outside.yaml'))).toBe(false);
    expect(readFileSync(join(vaultPath, 'Notes', 'x.yaml'), 'utf8')).toBe('someone else\'s file\n');
    expect(blockedEntries('schema-file-render-blocked')).toEqual([]);
    expect(existsSync(join(vaultPath, '.schemas', '_fields.yaml'))).toBe(true);
  });

  it('undo of its creation leaves the file at that path alone', () => {
    const file = join(vaultPath, 'Notes', 'x.yaml');
    mkdirSync(join(vaultPath, 'Notes'), { recursive: true });
    writeFileSync(file, 'someone else\'s file\n');
    for (const name of ['../Notes/x', '_fields']) {
      const operationId = createOperation(db, { source_tool: 'create-schema', description: `create-schema: ${name}` });
      captureSchemaSnapshot(db, operationId, name, { was_new: true });
      insertLegacySchema(name);
      db.prepare('UPDATE undo_operations SET schema_count = 1 WHERE operation_id = ?').run(operationId);
      finalizeOperation(db, operationId);
      if (name === '_fields') renderFieldsFile(db, vaultPath);

      restoreMany(db, writeLock, vaultPath, { operation_ids: [operationId], dry_run: false });

      expect(getSchemaDefinition(db, name)).toBeNull();
    }
    expect(readFileSync(file, 'utf8')).toBe('someone else\'s file\n');
    expect(existsSync(join(vaultPath, '.schemas', '_fields.yaml'))).toBe(true);
  });
});

describe('a schema that already has a slash in its name, inside .schemas/', () => {
  it('keeps rendering, updating and deleting its file, as before', async () => {
    for (const name of ['a/b', 'a\\b']) {
      insertLegacySchema(name);
      const file = join(vaultPath, '.schemas', `${name}.yaml`);
      expect(renderSchemaFile(db, vaultPath, name)).toBe(true);
      expect(readFileSync(file, 'utf8')).toContain(`name: ${name}`);

      const updated = await updateSchemaTool()({ name, display_name: 'Nested' });
      expect([name, updated.ok, updated.warnings]).toEqual([name, true, []]);
      expect(readFileSync(file, 'utf8')).toContain('display_name: Nested');

      expect((await deleteSchemaTool()({ name })).ok).toBe(true);
      expect(existsSync(file)).toBe(false);
    }
    expect(blockedEntries('schema-file-render-blocked')).toEqual([]);
  });
});

describe('upgrade: an installation with the default kinds', () => {
  const KINDS = ['project', 'task', 'meeting', 'person', 'company', 'note', 'wiki', 'transcript'];

  it('keeps every schema file, its hash and its schema exactly as the previous version left them', () => {
    // As the previous version left it: each kind's schema rendered, hashes recorded.
    for (const name of KINDS) createSchemaDefinition(db, { name, field_claims: [{ field: 'status' }] });
    startupSchemaRender(db, vaultPath);
    const files = Object.fromEntries(KINDS.map(name => [name, readFileSync(join(vaultPath, '.schemas', `${name}.yaml`), 'utf8')]));
    const hashes = db.prepare('SELECT file_path, content_hash FROM schema_file_hashes ORDER BY file_path').all();
    const schemas = db.prepare('SELECT * FROM schemas ORDER BY name').all();

    startupSchemaRender(db, vaultPath);
    for (const name of KINDS) expect(renderSchemaFile(db, vaultPath, name)).toBe(true);

    for (const name of KINDS) {
      expect(readFileSync(join(vaultPath, '.schemas', `${name}.yaml`), 'utf8')).toBe(files[name]);
      expect(schemaFilePath(vaultPath, name)).toBe(join(vaultPath, '.schemas', `${name}.yaml`));
    }
    expect(db.prepare('SELECT file_path, content_hash FROM schema_file_hashes ORDER BY file_path').all()).toEqual(hashes);
    expect(db.prepare('SELECT * FROM schemas ORDER BY name').all()).toEqual(schemas);
    expect(db.prepare("SELECT COUNT(*) AS n FROM edits_log WHERE event_type LIKE 'schema-file-%'").get()).toEqual({ n: 0 });
  });
});
