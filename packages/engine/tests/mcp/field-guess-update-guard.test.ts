import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { createTestDb } from '../helpers/db.js';
import { createTempVault } from '../helpers/vault.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { createSchemaDefinition, updateSchemaDefinition } from '../../src/schema/crud.js';
import { definitionHash } from '../../src/field-guess/candidates.js';
import { executeMutation } from '../../src/pipeline/execute.js';
import { loadEffectiveFields } from '../../src/pipeline/schema-context.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { registerListFieldGuessCandidates } from '../../src/mcp/tools/list-field-guess-candidates.js';
import { setMeta } from '../../src/db/meta.js';
import { EXPLICIT_NULL_BACKFILL_META_KEY } from '../../src/sync/explicit-null-backfill.js';
import { processFileChange } from '../../src/sync/watcher.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';

interface ToolResult {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
}

function getValidatedHandler(
  register: (server: McpServer) => void,
): (args: Record<string, unknown>) => Promise<unknown> {
  let captured: ((args: Record<string, unknown>) => Promise<unknown>) | undefined;
  const server = {
    tool: (
      _name: string,
      _description: string,
      schema: Record<string, z.ZodType>,
      callback: (args: Record<string, unknown>) => Promise<unknown>,
    ) => {
      const parser = z.object(schema);
      captured = async (args) => {
        const parsed = parser.safeParse(args);
        if (parsed.success) return callback(parsed.data);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ok: false,
              error: { code: 'INVALID_PARAMS', message: parsed.error.issues[0]?.message ?? 'Validation error' },
              warnings: [],
            }),
          }],
        };
      };
    },
  } as unknown as McpServer;
  register(server);
  if (captured === undefined) throw new Error('update-node was not registered');
  return captured;
}

function payload(result: unknown): ToolResult {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text) as ToolResult;
}

describe('update-node field_guess_guard', () => {
  let db: Database.Database;
  let vaultPath: string;
  let cleanup: () => void;
  let writeLock: WriteLockManager;
  let handler: (args: Record<string, unknown>) => Promise<unknown>;

  beforeEach(() => {
    db = createTestDb();
    ({ vaultPath, cleanup } = createTempVault());
    writeLock = new WriteLockManager();
    handler = getValidatedHandler(server => registerUpdateNode(server, db, writeLock, vaultPath));
  });

  afterEach(() => {
    db.close();
    cleanup();
  });

  function createProject(): { nodeId: string; version: number; contentHash: string } {
    createSchemaDefinition(db, { name: 'Project', field_claims: [] });
    const created = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'Project.md', title: 'Project',
      types: ['Project'], fields: {}, body: 'Project evidence.',
    });
    const row = db.prepare('SELECT version, content_hash FROM nodes WHERE id = ?').get(created.node_id) as {
      version: number; content_hash: string;
    };
    return { nodeId: created.node_id, version: row.version, contentHash: row.content_hash };
  }

  function offered(...fields: string[]) {
    const effective = loadEffectiveFields(db, ['Project']);
    return fields.map(field => ({
      field,
      definition_hash: definitionHash(effective.get(field)!),
    }));
  }

  function createGuardedStatusProject() {
    createGlobalField(db, {
      name: 'status', field_type: 'enum', enum_values: ['active', 'paused'],
      required: true, ai_guessable: true,
    });
    const project = createProject();
    updateSchemaDefinition(db, 'Project', { field_claims: [{ field: 'status' }] });
    return {
      project,
      guard: { offered_fields: offered('status') },
    };
  }

  function mutationState(nodeId: string) {
    return {
      fields: db.prepare(
        'SELECT * FROM node_fields WHERE node_id = ? ORDER BY field_name',
      ).all(nodeId),
      counts: db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM undo_operations) AS undo_operations,
          (SELECT COUNT(*) FROM undo_snapshots) AS undo_snapshots,
          (SELECT COUNT(*) FROM edits_log) AS edits_log,
          (SELECT COUNT(*) FROM sync_log) AS sync_log
      `).get(),
    };
  }

  it('applies accepted fields while preserving an abstained required absence and skipping its default', async () => {
    createGlobalField(db, {
      name: 'status', field_type: 'enum', enum_values: ['active', 'paused'],
      required: true, ai_guessable: true,
    });
    createGlobalField(db, {
      name: 'context', field_type: 'string', required: true,
      default_value: 'must-not-materialize', ai_guessable: true,
    });
    const project = createProject();
    updateSchemaDefinition(db, 'Project', {
      field_claims: [{ field: 'status' }, { field: 'context' }],
    });

    const args = {
      node_id: project.nodeId,
      set_fields: { status: 'active' },
      expected_version: project.version,
      expected_content_hash: project.contentHash,
      field_guess_guard: { offered_fields: offered('status', 'context') },
    };
    const preview = payload(await handler({ ...args, dry_run: true }));
    expect(preview.ok).toBe(true);
    expect(preview.data?.preview).toMatchObject({
      coerced_state: { status: expect.objectContaining({ value: 'active' }) },
    });
    expect((preview.data?.preview as { coerced_state: object }).coerced_state).not.toHaveProperty('context');
    expect(db.prepare('SELECT * FROM node_fields WHERE node_id = ?').all(project.nodeId)).toEqual([]);

    const result = payload(await handler({ ...args, dry_run: false }));

    expect(result.ok).toBe(true);
    expect(db.prepare(
      'SELECT field_name, value_text FROM node_fields WHERE node_id = ? ORDER BY field_name',
    ).all(project.nodeId)).toEqual([{ field_name: 'status', value_text: 'active' }]);
  });

  it('dry-run rejects a stale expected version without mutation side effects', async () => {
    const { project, guard } = createGuardedStatusProject();
    db.prepare('UPDATE nodes SET version = version + 1 WHERE id = ?').run(project.nodeId);
    const before = mutationState(project.nodeId);
    const projectPath = join(vaultPath, 'Project.md');
    const beforeFile = readFileSync(projectPath, 'utf-8');

    const result = payload(await handler({
      node_id: project.nodeId,
      set_fields: { status: 'active' },
      expected_version: project.version,
      expected_content_hash: project.contentHash,
      field_guess_guard: guard,
      dry_run: true,
    }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: 'STALE_NODE' });
    expect(mutationState(project.nodeId)).toEqual(before);
    expect(readFileSync(projectPath, 'utf-8')).toBe(beforeFile);
  });

  it('dry-run rejects a stale expected database content hash without mutation side effects', async () => {
    const { project, guard } = createGuardedStatusProject();
    db.prepare('UPDATE nodes SET content_hash = ? WHERE id = ?')
      .run('db-content-moved', project.nodeId);
    const before = mutationState(project.nodeId);
    const projectPath = join(vaultPath, 'Project.md');
    const beforeFile = readFileSync(projectPath, 'utf-8');

    const result = payload(await handler({
      node_id: project.nodeId,
      set_fields: { status: 'active' },
      expected_version: project.version,
      expected_content_hash: project.contentHash,
      field_guess_guard: guard,
      dry_run: true,
    }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: 'CONTENT_HASH_MISMATCH' });
    expect(mutationState(project.nodeId)).toEqual(before);
    expect(readFileSync(projectPath, 'utf-8')).toBe(beforeFile);
  });

  it('dry-run rejects a stale on-disk content hash without mutation side effects', async () => {
    const { project, guard } = createGuardedStatusProject();
    const projectPath = join(vaultPath, 'Project.md');
    const humanEdit = `${readFileSync(projectPath, 'utf-8')}\nHuman edit not in SQLite.\n`;
    writeFileSync(projectPath, humanEdit, 'utf-8');
    const before = mutationState(project.nodeId);

    const result = payload(await handler({
      node_id: project.nodeId,
      set_fields: { status: 'active' },
      expected_version: project.version,
      expected_content_hash: project.contentHash,
      field_guess_guard: guard,
      dry_run: true,
    }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: 'CONTENT_HASH_MISMATCH' });
    expect(mutationState(project.nodeId)).toEqual(before);
    expect(readFileSync(projectPath, 'utf-8')).toBe(humanEdit);
  });

  it('accepts every offered field that candidate discovery can return', async () => {
    const longField = `field_${'x'.repeat(501)}`;
    const fields = [longField, ...Array.from({ length: 100 }, (_, index) => `field_${index}`)];
    for (const field of fields) {
      createGlobalField(db, {
        name: field,
        field_type: 'string',
        required: true,
        ai_guessable: true,
      });
    }
    const project = createProject();
    updateSchemaDefinition(db, 'Project', {
      field_claims: fields.map(field => ({ field })),
    });

    const result = payload(await handler({
      node_id: project.nodeId,
      set_fields: { [longField]: 'accepted' },
      expected_version: project.version,
      expected_content_hash: project.contentHash,
      field_guess_guard: { offered_fields: offered(...fields) },
      dry_run: false,
    }));

    expect(result.ok).toBe(true);
    expect(db.prepare(
      'SELECT value_text FROM node_fields WHERE node_id = ? AND field_name = ?',
    ).get(project.nodeId, longField)).toEqual({ value_text: 'accepted' });
  });

  it('accepts every canonical list-reference target that resolution can return', async () => {
    const requiredType = `Context_${'x'.repeat(501)}`;
    createGlobalField(db, {
      name: 'owners',
      field_type: 'list',
      list_item_type: 'reference',
      reference_target: requiredType,
      required: true,
      ai_guessable: true,
    });
    createSchemaDefinition(db, { name: requiredType, field_claims: [] });
    const targets = Array.from({ length: 101 }, (_, index) => executeMutation(
      db,
      writeLock,
      vaultPath,
      {
        source: 'tool',
        node_id: null,
        file_path: `Context ${index}.md`,
        title: `Context ${index}`,
        types: [requiredType],
        fields: {},
        body: '',
      },
    ));
    const project = createProject();
    updateSchemaDefinition(db, 'Project', { field_claims: [{ field: 'owners' }] });
    const titles = targets.map((_, index) => `Context ${index}`);

    const result = payload(await handler({
      node_id: project.nodeId,
      set_fields: { owners: titles },
      expected_version: project.version,
      expected_content_hash: project.contentHash,
      field_guess_guard: {
        offered_fields: [{
          ...offered('owners')[0],
          reference_targets: targets.map((target, index) => ({
            node_id: target.node_id,
            title: titles[index],
            required_type: requiredType,
          })),
        }],
      },
      dry_run: false,
    }));

    expect(result.ok).toBe(true);
    expect(db.prepare(
      'SELECT value_json FROM node_fields WHERE node_id = ? AND field_name = ?',
    ).get(project.nodeId, 'owners')).toEqual({ value_json: JSON.stringify(titles) });
  });

  it('fails stale when a still-guessable offered definition hash changes', async () => {
    createGlobalField(db, {
      name: 'status', field_type: 'enum', enum_values: ['active', 'paused'],
      required: true, ai_guessable: true, description: 'Original definition',
    });
    const project = createProject();
    updateSchemaDefinition(db, 'Project', { field_claims: [{ field: 'status' }] });
    const guard = { offered_fields: offered('status') };
    db.prepare('UPDATE global_fields SET description = ? WHERE name = ?')
      .run('Changed definition', 'status');

    const result = payload(await handler({
      node_id: project.nodeId,
      set_fields: { status: 'active' },
      expected_version: project.version,
      expected_content_hash: project.contentHash,
      field_guess_guard: guard,
      dry_run: false,
    }));

    expect(result.error).toMatchObject({ code: 'STALE_NODE' });
    expect(db.prepare('SELECT * FROM node_fields WHERE node_id = ?').all(project.nodeId)).toEqual([]);
  });

  it('discards its empty undo operation when the ordinary node CAS is stale', async () => {
    createGlobalField(db, {
      name: 'status', field_type: 'enum', enum_values: ['active', 'paused'],
      required: true, ai_guessable: true,
    });
    const project = createProject();
    updateSchemaDefinition(db, 'Project', { field_claims: [{ field: 'status' }] });
    const guard = { offered_fields: offered('status') };
    db.prepare('UPDATE nodes SET version = version + 1 WHERE id = ?').run(project.nodeId);

    const result = payload(await handler({
      node_id: project.nodeId,
      set_fields: { status: 'active' },
      expected_version: project.version,
      expected_content_hash: project.contentHash,
      field_guess_guard: guard,
      dry_run: false,
    }));

    expect(result.error).toMatchObject({ code: 'STALE_NODE' });
    expect(db.prepare('SELECT * FROM undo_operations').all()).toEqual([]);
  });

  it('fails stale without overwriting a human edit not yet ingested by the watcher', async () => {
    createGlobalField(db, {
      name: 'status', field_type: 'enum', enum_values: ['active', 'paused'],
      required: true, ai_guessable: true,
    });
    const project = createProject();
    updateSchemaDefinition(db, 'Project', { field_claims: [{ field: 'status' }] });
    const projectPath = join(vaultPath, 'Project.md');
    const humanEdit = `${readFileSync(projectPath, 'utf-8')}\nHuman edit not in SQLite.\n`;
    writeFileSync(projectPath, humanEdit, 'utf-8');

    const result = payload(await handler({
      node_id: project.nodeId,
      set_fields: { status: 'active' },
      expected_version: project.version,
      expected_content_hash: project.contentHash,
      field_guess_guard: { offered_fields: offered('status') },
      dry_run: false,
    }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: 'CONTENT_HASH_MISMATCH' });
    expect(readFileSync(projectPath, 'utf-8')).toBe(humanEdit);
    expect(db.prepare('SELECT * FROM node_fields WHERE node_id = ?').all(project.nodeId)).toEqual([]);
    expect(db.prepare('SELECT * FROM undo_operations').all()).toEqual([]);
  });

  it('fails stale without a write when an offered definition is no longer AI guessable', async () => {
    createGlobalField(db, {
      name: 'status', field_type: 'enum', enum_values: ['active', 'paused'],
      required: true, ai_guessable: true,
    });
    const project = createProject();
    updateSchemaDefinition(db, 'Project', { field_claims: [{ field: 'status' }] });
    const guard = { offered_fields: offered('status') };
    db.prepare('UPDATE global_fields SET ai_guessable = 0 WHERE name = ?').run('status');

    const result = payload(await handler({
      node_id: project.nodeId,
      set_fields: { status: 'active' },
      expected_version: project.version,
      expected_content_hash: project.contentHash,
      field_guess_guard: guard,
      dry_run: false,
    }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: 'STALE_NODE' });
    expect(db.prepare('SELECT * FROM node_fields WHERE node_id = ?').all(project.nodeId)).toEqual([]);
    expect(db.prepare('SELECT * FROM undo_operations').all()).toEqual([]);
  });

  it('atomically rejects a reference whose resolved target was deleted before the write', async () => {
    createGlobalField(db, {
      name: 'owner', field_type: 'reference', reference_target: 'Context',
      required: true, ai_guessable: true,
    });
    createSchemaDefinition(db, { name: 'Context', field_claims: [] });
    const target = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'Acme.md', title: 'Acme',
      types: ['Context'], fields: {}, body: '',
    });
    const project = createProject();
    updateSchemaDefinition(db, 'Project', { field_claims: [{ field: 'owner' }] });
    const guard = {
      offered_fields: [{
        ...offered('owner')[0],
        reference_targets: [{ node_id: target.node_id, title: 'Acme', required_type: 'Context' }],
      }],
    };
    db.prepare('DELETE FROM nodes WHERE id = ?').run(target.node_id);

    const result = payload(await handler({
      node_id: project.nodeId,
      set_fields: { owner: 'Acme' },
      expected_version: project.version,
      expected_content_hash: project.contentHash,
      field_guess_guard: guard,
      dry_run: false,
    }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: 'STALE_NODE' });
    expect(db.prepare('SELECT * FROM node_fields WHERE node_id = ?').all(project.nodeId)).toEqual([]);
  });

  it('accepts a canonical reference whose guarded identity and type are unchanged', async () => {
    createGlobalField(db, {
      name: 'owner', field_type: 'reference', reference_target: 'Context',
      required: true, ai_guessable: true,
    });
    createSchemaDefinition(db, { name: 'Context', field_claims: [] });
    const target = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'Acme Valid.md', title: 'Acme Valid',
      types: ['Context'], fields: {}, body: '',
    });
    const project = createProject();
    updateSchemaDefinition(db, 'Project', { field_claims: [{ field: 'owner' }] });

    const result = payload(await handler({
      node_id: project.nodeId,
      set_fields: { owner: 'Acme Valid' },
      expected_version: project.version,
      expected_content_hash: project.contentHash,
      field_guess_guard: {
        offered_fields: [{
          ...offered('owner')[0],
          reference_targets: [{
            node_id: target.node_id, title: 'Acme Valid', required_type: 'Context',
          }],
        }],
      },
      dry_run: false,
    }));

    expect(result.ok).toBe(true);
    expect(db.prepare(
      'SELECT value_text FROM node_fields WHERE node_id = ? AND field_name = ?',
    ).get(project.nodeId, 'owner')).toEqual({ value_text: 'Acme Valid' });
  });

  it('fails stale when a case-only duplicate makes a resolved reference ambiguous', async () => {
    createGlobalField(db, {
      name: 'owner', field_type: 'reference', reference_target: 'Context',
      required: true, ai_guessable: true,
    });
    createSchemaDefinition(db, { name: 'Context', field_claims: [] });
    const target = executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'Acme.md', title: 'Acme',
      types: ['Context'], fields: {}, body: '',
    });
    const project = createProject();
    updateSchemaDefinition(db, 'Project', { field_claims: [{ field: 'owner' }] });
    const guard = {
      offered_fields: [{
        ...offered('owner')[0],
        reference_targets: [{ node_id: target.node_id, title: 'Acme', required_type: 'Context' }],
      }],
    };
    executeMutation(db, writeLock, vaultPath, {
      source: 'tool', node_id: null, file_path: 'Archive/acme.md', title: 'acme',
      types: ['Context'], fields: {}, body: '',
    });

    const result = payload(await handler({
      node_id: project.nodeId,
      set_fields: { owner: 'Acme' },
      expected_version: project.version,
      expected_content_hash: project.contentHash,
      field_guess_guard: guard,
      dry_run: false,
    }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatchObject({ code: 'STALE_NODE' });
    expect(db.prepare('SELECT * FROM node_fields WHERE node_id = ?').all(project.nodeId)).toEqual([]);
    expect(db.prepare('SELECT * FROM undo_operations').all()).toEqual([]);
  });
  describe('a guard marked requested (#644)', () => {
    /** An optional field the owner never marked AI-guessable: the nightly rule never offers it. */
    function createMeetingDateProject() {
      createGlobalField(db, { name: 'held_on', field_type: 'date', required: false, ai_guessable: false });
      const project = createProject();
      updateSchemaDefinition(db, 'Project', { field_claims: [{ field: 'held_on' }] });
      return {
        node_id: project.nodeId,
        set_fields: { held_on: '2024-03-01' },
        expected_version: project.version,
        expected_content_hash: project.contentHash,
      };
    }

    it('is stale under the nightly rule and writes under the requested one, returning its undo operation', async () => {
      const args = createMeetingDateProject();
      const nightly = payload(await handler({ ...args, field_guess_guard: { offered_fields: offered('held_on') } }));
      expect(nightly).toMatchObject({ ok: false, error: { code: 'STALE_NODE' } });

      const guard = { offered_fields: offered('held_on'), requested: true };
      expect(payload(await handler({ ...args, field_guess_guard: guard, dry_run: true })).ok).toBe(true);
      expect(db.prepare('SELECT COUNT(*) AS n FROM node_fields WHERE node_id = ?').get(args.node_id)).toEqual({ n: 0 });

      const written = payload(await handler({ ...args, field_guess_guard: guard }));
      expect(written.ok).toBe(true);
      expect(readFileSync(join(vaultPath, 'Project.md'), 'utf-8')).toContain('held_on: 2024-03-01');
      // The call's own undo operation, so a run can undo exactly what it wrote.
      const operations = db.prepare('SELECT operation_id FROM undo_operations').all() as Array<{ operation_id: string }>;
      expect(operations).toHaveLength(1);
      expect(written.data?.operation_id).toBe(operations[0]!.operation_id);
    });

    it('replaces a value that fails the field\'s type only when the run asked to', async () => {
      const args = createMeetingDateProject();
      // The note's date says "TBD": there, and not a date. (An edit in Obsidian leaves this; a tool write would be refused.)
      db.prepare("INSERT INTO node_fields (node_id, field_name, value_text, source) VALUES (?, 'held_on', 'TBD', 'frontmatter')").run(args.node_id);
      const offer = offered('held_on');

      const filling = payload(await handler({ ...args, field_guess_guard: { offered_fields: offer, requested: true } }));
      expect(filling).toMatchObject({ ok: false, error: { code: 'STALE_NODE' } });
      expect(db.prepare("SELECT value_text FROM node_fields WHERE node_id = ? AND field_name = 'held_on'").get(args.node_id)).toEqual({ value_text: 'TBD' });

      const replacing = payload(await handler({ ...args, field_guess_guard: { offered_fields: offer, requested: true, replace_invalid: true } }));
      expect(replacing.ok).toBe(true);
      expect(readFileSync(join(vaultPath, 'Project.md'), 'utf-8')).toContain('held_on: 2024-03-01');
    });

    describe('text typed into the note that the database refused for its type', () => {
      /**
       * The common way a field comes to "hold" a wrong value: someone types TBD into a date
       * property. The watcher stores nothing for it and the file keeps the text, so to the
       * database the field is empty.
       */
      function typeTbd() {
        const args = createMeetingDateProject();
        const path = join(vaultPath, 'Project.md');
        writeFileSync(path, readFileSync(path, 'utf-8').replace('---\n', '---\nheld_on: TBD\n'), 'utf-8');
        processFileChange(path, 'Project.md', db, writeLock, vaultPath);
        expect(db.prepare("SELECT COUNT(*) AS n FROM node_fields WHERE node_id = ? AND field_name = 'held_on'").get(args.node_id)).toEqual({ n: 0 });
        const row = db.prepare('SELECT version, content_hash FROM nodes WHERE id = ?').get(args.node_id) as { version: number; content_hash: string };
        return { ...args, expected_version: row.version, expected_content_hash: row.content_hash, path };
      }

      function listing(requested: Record<string, unknown>) {
        const server = new McpServer({ name: 'test', version: '0' });
        registerListFieldGuessCandidates(server, db, vaultPath);
        setMeta(db, EXPLICIT_NULL_BACKFILL_META_KEY, 'complete');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tool = (server as any)._registeredTools['list-field-guess-candidates'];
        return (tool.callback ?? tool.handler)({ requested }) as Promise<unknown>;
      }
      const offeredFields = (result: unknown) => (JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text) as {
        data: { candidates: Array<{ fields: Array<{ field: string; eligibility: string; held_text?: string }> }> };
      }).data.candidates.map(candidate => candidate.fields);

      it('is not an empty field: a run is not offered it, and a write that would replace it is refused', async () => {
        const args = typeTbd();
        expect(offeredFields(await listing({ fields: ['held_on'] }))).toEqual([]);

        const filling = payload(await handler({ ...args, field_guess_guard: { offered_fields: offered('held_on'), requested: true } }));
        expect(filling).toMatchObject({ ok: false, error: { code: 'STALE_NODE' } });
        expect(readFileSync(args.path, 'utf-8')).toContain('held_on: TBD');
      });

      it('is offered, with what it says, and replaced only for a run that asks to', async () => {
        const args = typeTbd();
        expect(offeredFields(await listing({ fields: ['held_on'], replace_invalid: true }))).toEqual([[
          expect.objectContaining({ field: 'held_on', eligibility: 'invalid', held_text: 'TBD' }),
        ]]);

        const guard = { offered_fields: offered('held_on'), requested: true, replace_invalid: true };
        expect(payload(await handler({ ...args, field_guess_guard: guard, dry_run: true })).ok).toBe(true);
        expect(readFileSync(args.path, 'utf-8')).toContain('held_on: TBD');
        expect(payload(await handler({ ...args, field_guess_guard: guard })).ok).toBe(true);
        const written = readFileSync(args.path, 'utf-8');
        expect(written).toContain('held_on: 2024-03-01');
        expect(written).not.toContain('TBD');
      });

      it('is protected the same when the database kept an empty value for the field', async () => {
        // Two ways a field holds "nothing" before the text is typed: an empty key, and an empty list.
        createGlobalField(db, { name: 'days', field_type: 'list', list_item_type: 'date', required: false, ai_guessable: false });
        const args = createMeetingDateProject();
        updateSchemaDefinition(db, 'Project', { field_claims: [{ field: 'held_on' }, { field: 'days' }] });
        const path = join(vaultPath, 'Project.md');
        const withFrontmatter = (lines: string): void => {
          writeFileSync(path, readFileSync(path, 'utf-8').replace(/^---\n(?:held_on:.*\n|days:.*\n)*/, `---\n${lines}`), 'utf-8');
          processFileChange(path, 'Project.md', db, writeLock, vaultPath);
        };
        withFrontmatter('held_on:\ndays: []\n');
        // Then someone types into both. The watcher refuses the text and keeps what it had.
        withFrontmatter('held_on: TBD\ndays: [TBD]\n');
        expect(db.prepare("SELECT value_json FROM node_fields WHERE node_id = ? AND field_name = 'days'").get(args.node_id)).toEqual({ value_json: '[]' });
        const row = db.prepare('SELECT version, content_hash FROM nodes WHERE id = ?').get(args.node_id) as { version: number; content_hash: string };
        const current = { ...args, expected_version: row.version, expected_content_hash: row.content_hash };

        // Neither is an empty field to a run that did not ask to replace.
        expect(offeredFields(await listing({ fields: ['held_on', 'days'] }))).toEqual([]);
        for (const [field, value] of [['held_on', '2024-03-01'], ['days', ['2024-03-01']]] as const) {
          const refused = payload(await handler({
            ...current, set_fields: { [field]: value }, field_guess_guard: { offered_fields: offered('held_on', 'days'), requested: true },
          }));
          expect(refused).toMatchObject({ ok: false, error: { code: 'STALE_NODE' } });
        }
        expect(readFileSync(path, 'utf-8')).toContain('held_on: TBD');
        expect(readFileSync(path, 'utf-8')).toContain('days: [TBD]');

        // A run that asks is offered both, with what each says.
        const [fields] = offeredFields(await listing({ fields: ['held_on', 'days'], replace_invalid: true }));
        expect(Object.fromEntries(fields!.map(field => [field.field, `${field.eligibility}: ${field.held_text}`])))
          .toEqual({ held_on: 'invalid: TBD', days: 'invalid: ["TBD"]' });
      });

      it('leaves the nightly rule reading the database alone', async () => {
        const args = typeTbd();
        // The owner marks the field and makes it required: the nightly sweep may now fill it, as before.
        db.prepare("UPDATE global_fields SET ai_guessable = 1, required = 1 WHERE name = 'held_on'").run();
        const nightly = payload(await handler({ ...args, field_guess_guard: { offered_fields: offered('held_on') } }));
        expect(nightly.ok).toBe(true);
      });
    });

    it('still refuses a field that already holds a valid value', async () => {
      const args = createMeetingDateProject();
      const guard = { offered_fields: offered('held_on'), requested: true };
      expect(payload(await handler({ ...args, field_guess_guard: guard })).ok).toBe(true);
      const row = db.prepare('SELECT version, content_hash FROM nodes WHERE id = ?').get(args.node_id) as { version: number; content_hash: string };
      const again = payload(await handler({
        ...args, set_fields: { held_on: '2025-01-01' }, expected_version: row.version, expected_content_hash: row.content_hash,
        field_guess_guard: guard,
      }));
      expect(again).toMatchObject({ ok: false, error: { code: 'STALE_NODE' } });
      expect(readFileSync(join(vaultPath, 'Project.md'), 'utf-8')).toContain('held_on: 2024-03-01');
    });
  });
});
