import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createSchema } from '../../src/db/schema.js';
import { addUiHints, addUndoTables } from '../../src/db/migrate.js';
import {
  getConversation,
  linkConversationToDoc,
  saveConversation,
  upgradeConversationLinks,
  upgradeConversationsStore,
} from '../../src/conversations/store.js';
import { createSchemaDefinition } from '../../src/schema/crud.js';
import { updateSchemaDefinition } from '../../src/schema/crud.js';
import { createGlobalField } from '../../src/global-fields/crud.js';
import { definitionHash } from '../../src/field-guess/candidates.js';
import { loadEffectiveFields } from '../../src/pipeline/schema-context.js';
import { registerCreateNode } from '../../src/mcp/tools/create-node.js';
import { registerUpdateNode } from '../../src/mcp/tools/update-node.js';
import { WriteLockManager } from '../../src/sync/write-lock.js';
import { createTempVault } from '../helpers/vault.js';

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

function parse(result: Awaited<ReturnType<Handler>>): any {
  return JSON.parse(result.content[0]!.text);
}

describe('conversation-authoritative capture mutations', () => {
  let db: Database.Database;
  let vaultPath: string;
  let cleanup: () => void;
  let createNode: Handler;
  let updateNode: Handler;

  beforeEach(() => {
    ({ vaultPath, cleanup } = createTempVault());
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createSchema(db);
    addUndoTables(db);
    addUiHints(db);
    upgradeConversationsStore(db);
    upgradeConversationLinks(db);
    createSchemaDefinition(db, { name: 'note', field_claims: [] });
    saveConversation(db, { id: 'conversation-1', title: 'Chat', messages: [] }, '2026-08-25T00:00:00.000Z');
    linkConversationToDoc(db, 'conversation-1', 'doc-1', Date.parse('2026-08-25T00:00:01.000Z'));

    const handlers = new Map<string, Handler>();
    const server = {
      tool: (name: string, _description: string, _schema: unknown, handler: Handler) => handlers.set(name, handler),
    } as unknown as McpServer;
    const lock = new WriteLockManager();
    registerCreateNode(server, db, lock, vaultPath);
    registerUpdateNode(server, db, lock, vaultPath);
    createNode = handlers.get('create-node')!;
    updateNode = handlers.get('update-node')!;
  });

  afterEach(() => {
    db.close();
    cleanup();
  });

  function guard(overrides: Record<string, unknown> = {}) {
    return {
      conversation_id: 'conversation-1',
      expected_revision: getConversation(db, 'conversation-1')!.conversation.revision,
      expected_link_mode: 'bound',
      expected_linked_docs: ['doc-1'],
      ...overrides,
    };
  }

  async function fieldGuessDestination() {
    createGlobalField(db, {
      name: 'status', field_type: 'enum', enum_values: ['active', 'paused'],
      required: true, ai_guessable: true,
    });
    const created = parse(await createNode({ title: 'Guarded destination', types: ['note'], body: 'before' }));
    updateSchemaDefinition(db, 'note', { field_claims: [{ field: 'status' }] });
    const row = db.prepare('SELECT version, content_hash FROM nodes WHERE id = ?')
      .get(created.data.node_id) as { version: number; content_hash: string };
    const effective = loadEffectiveFields(db, ['note']).get('status')!;
    return {
      nodeId: created.data.node_id as string,
      version: row.version,
      contentHash: row.content_hash,
      fieldGuessGuard: {
        offered_fields: [{ field: 'status', definition_hash: definitionHash(effective) }],
      },
    };
  }

  it('accepts an exact guard for dry-run and live create while preserving omission compatibility', async () => {
    const dry = parse(await createNode({
      title: 'Guarded preview', types: ['note'], body: 'preview', dry_run: true,
      conversation_authority: guard(),
    }));
    expect(dry.ok).toBe(true);

    const live = parse(await createNode({
      title: 'Guarded live', types: ['note'], body: 'body',
      conversation_authority: guard(),
    }));
    expect(live.ok).toBe(true);

    const legacy = parse(await createNode({ title: 'Legacy caller', types: ['note'], body: 'body' }));
    expect(legacy.ok).toBe(true);
  });

  it.each([
    ['revision', { expected_revision: 1 }],
    ['link mode', { expected_link_mode: 'unbound' }],
    ['linked-node set', { expected_linked_docs: ['doc-1', 'doc-new'] }],
  ])('rejects a stale create %s guard without writing', async (_label, overrides) => {
    const result = parse(await createNode({
      title: `Rejected ${_label}`, types: ['note'], body: 'must not persist',
      conversation_authority: guard(overrides),
    }));

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('CONFLICT');
    expect(result.error.details).toMatchObject({
      conversation_id: 'conversation-1',
      current_revision: getConversation(db, 'conversation-1')!.conversation.revision,
      current_link_mode: 'bound',
      current_linked_docs: ['doc-1'],
    });
    expect(existsSync(join(vaultPath, `${`Rejected ${_label}`}.md`))).toBe(false);
  });

  it('rejects stale dry-run and live update guards after a link-set race', async () => {
    const created = parse(await createNode({ title: 'Destination', types: ['note'], body: 'before' }));
    const staleGuard = guard();
    linkConversationToDoc(db, 'conversation-1', 'doc-new', Date.parse('2026-08-25T00:00:02.000Z'));

    for (const dry_run of [true, false]) {
      const result = parse(await updateNode({
        node_id: created.data.node_id,
        append_body: 'after',
        dry_run,
        conversation_authority: staleGuard,
      }));
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('CONFLICT');
    }
    expect((db.prepare('SELECT body FROM nodes WHERE id = ?').get(created.data.node_id) as { body: string }).body).not.toContain('after');
  });

  it('composes conversation authority and field-guess guards for dry-run and live updates', async () => {
    const destination = await fieldGuessDestination();
    const args = {
      node_id: destination.nodeId,
      set_fields: { status: 'active' },
      expected_version: destination.version,
      expected_content_hash: destination.contentHash,
      field_guess_guard: destination.fieldGuessGuard,
      conversation_authority: guard(),
    };

    expect(parse(await updateNode({ ...args, dry_run: true })).ok).toBe(true);
    expect(parse(await updateNode({ ...args, dry_run: false })).ok).toBe(true);
    expect(db.prepare(
      'SELECT value_text FROM node_fields WHERE node_id = ? AND field_name = ?',
    ).get(destination.nodeId, 'status')).toEqual({ value_text: 'active' });
  });

  it('atomically rejects a stale conversation authority when the field-guess guard is valid', async () => {
    const destination = await fieldGuessDestination();
    const undoBefore = db.prepare('SELECT * FROM undo_operations ORDER BY operation_id').all();
    const staleAuthority = guard();
    linkConversationToDoc(db, 'conversation-1', 'doc-new', Date.parse('2026-08-25T00:00:02.000Z'));

    const result = parse(await updateNode({
      node_id: destination.nodeId,
      set_fields: { status: 'active' },
      expected_version: destination.version,
      expected_content_hash: destination.contentHash,
      field_guess_guard: destination.fieldGuessGuard,
      conversation_authority: staleAuthority,
    }));

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('CONFLICT');
    expect(db.prepare(
      'SELECT * FROM node_fields WHERE node_id = ? AND field_name = ?',
    ).all(destination.nodeId, 'status')).toEqual([]);
    expect(db.prepare('SELECT * FROM undo_operations ORDER BY operation_id').all()).toEqual(undoBefore);
  });

  it('rejects conversation authority in update query mode', async () => {
    const result = parse(await updateNode({
      query: { title_contains: 'Destination' },
      set_fields: {},
      conversation_authority: guard(),
    }));
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('INVALID_PARAMS');
  });
});
