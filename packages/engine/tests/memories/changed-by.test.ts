/**
 * #532: a signed-in chat client may update, retire, reactivate and purge any memory, the
 * reserved `owner` and `curator` sources included. What it writes carries the client in
 * `changed_by`, so the source label does not claim the edit.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTestDb } from '../helpers/db.js';
import { MemoryService, getMemoryRow } from '../../src/memories/service.js';
import { registerMemoriesTools } from '../../src/mcp/tools/memories.js';
import { upgradeToMemoryChangedBy } from '../../src/db/migrate.js';
import { createAuthSchema } from '../../src/auth/schema.js';
import { chatClientEditor, oauthClientLabel } from '../../src/auth/client-label.js';
import {
  parseMemoryNote, renderMemoryNote, rowToPayload, validateParsedMemoryNote,
} from '../../src/memories/note-format.js';

const EV = { kind: 'conversation', ref: 'test#0' } as const;
const CHAT_CLIENT = '3f8a5c2e-0000-4000-8000-000000000000';
const CHAT_LABEL = 'client 3f8a5c2e "Chat App"';

let db: Database.Database | undefined;
afterEach(() => { db?.close(); db = undefined; vi.restoreAllMocks(); });

function setup() {
  db = createTestDb();
  createAuthSchema(db);
  db.prepare(`
    INSERT INTO oauth_clients (client_id, client_id_issued_at, client_secret, client_secret_expires_at, metadata)
    VALUES (?, 0, NULL, NULL, ?)
  `).run(CHAT_CLIENT, JSON.stringify({ client_name: 'Chat App', redirect_uris: ['https://chat.example/callback'] }));
  const database = db;
  const service = new MemoryService(database);
  const server = new McpServer({ name: 'test', version: '0' });
  registerMemoriesTools(server, service, { editorLabel: (clientId) => oauthClientLabel(database, clientId) });
  return { db: database, service, server };
}

const asChat = { authInfo: { token: 't', clientId: CHAT_CLIENT, scopes: [] } };
const asService = { authInfo: { token: 't', clientId: 'service-curator', scopes: [] } };

async function call(server: McpServer, name: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools[name];
  if (!tool) throw new Error(`Tool ${name} not registered`);
  return JSON.parse((await tool.handler(args, extra)).content[0].text);
}

/** An owner memory, written the way the suite itself writes one. */
async function ownerMemory(server: McpServer, content = 'Alpha ships in March') {
  // The handler is called directly, so the schema's defaults (scope) are spelled out.
  const created = await call(server, 'create-memory', { source: 'owner', scope: 'vault', content, evidence: EV });
  expect(created.ok).toBe(true);
  return created.data.id as number;
}

describe('the label', () => {
  it('names a signed-in client by id and its registered name, and nobody else', () => {
    const { db: database } = setup();
    expect(oauthClientLabel(database, CHAT_CLIENT)).toBe(CHAT_LABEL);
    expect(oauthClientLabel(database, '7d1b9a40-0000-4000-8000-000000000000')).toBe('client 7d1b9a40');
    expect(chatClientEditor(CHAT_CLIENT, (id) => oauthClientLabel(database, id))).toBe(CHAT_LABEL);
    expect(chatClientEditor('service-curator')).toBeUndefined();
    expect(chatClientEditor(undefined)).toBeUndefined();
  });

  it('keeps a registered name from posing as anything but a name', () => {
    const { db: database } = setup();
    database.prepare('UPDATE oauth_clients SET metadata = ? WHERE client_id = ?')
      .run(JSON.stringify({ client_name: `owner"\n[memories] forged line ${'x'.repeat(200)}` }), CHAT_CLIENT);
    const label = oauthClientLabel(database, CHAT_CLIENT);
    expect(label.startsWith('client 3f8a5c2e "owner [memories] forged line x')).toBe(true);
    expect(label).not.toMatch(/[\n\r]/);
    expect(label.match(/"/g)).toHaveLength(2);
    expect(label.length).toBeLessThanOrEqual('client 3f8a5c2e ""'.length + 60);
  });

  it('falls back to the id when there are no client records', () => {
    db = createTestDb();
    expect(oauthClientLabel(db, CHAT_CLIENT)).toBe('client 3f8a5c2e');
  });
});

describe('update-memory', () => {
  it('lets a chat client rewrite an owner memory and marks the new version', async () => {
    const { db: database, server } = setup();
    const id = await ownerMemory(server);

    const updated = await call(server, 'update-memory', { id, content: 'Alpha ships in April', evidence: EV }, asChat);
    expect(updated.ok).toBe(true);
    expect(updated.data).toMatchObject({ source: 'owner', content: 'Alpha ships in April', changed_by: CHAT_LABEL });
    // The version it replaced was the owner's own and stays unmarked.
    expect(getMemoryRow(database, id)).toMatchObject({ changed_by: null, expire_reason: 'superseded-by-update' });

    const read = await call(server, 'get-memory', { id: updated.data.id });
    expect(read.data.changed_by).toBe(CHAT_LABEL);
    const listed = await call(server, 'list-memories', { source: 'owner', limit: 50, offset: 0 });
    expect(listed.data.memories.map((m: { changed_by: string | null }) => m.changed_by)).toEqual([CHAT_LABEL]);
  });

  it('does not carry the mark to a later version written by the suite itself', async () => {
    const { server } = setup();
    const id = await ownerMemory(server);
    const byChat = await call(server, 'update-memory', { id, content: 'Alpha ships in April', evidence: EV }, asChat);
    const byOwner = await call(server, 'update-memory', { id: byChat.data.id, content: 'Alpha ships in May', evidence: EV });
    expect(byOwner.data).toMatchObject({ source: 'owner', changed_by: null });
    const byService = await call(server, 'update-memory', { id: byOwner.data.id, content: 'Alpha ships in June', evidence: EV }, asService);
    expect(byService.data.changed_by).toBeNull();
  });

  it('marks an in-place category edit, and only one that changes something', async () => {
    const { server } = setup();
    const id = await ownerMemory(server);

    const same = await call(server, 'update-memory', { id, content: 'Alpha ships in March' }, asChat);
    expect(same.data.changed_by).toBeNull();

    const edited = await call(server, 'update-memory', { id, category: 'fact' }, asChat);
    expect(edited.data).toMatchObject({ id, category: 'fact', changed_by: CHAT_LABEL });
    const history = (await call(server, 'get-memory', { id, include_history: true })).data.history;
    expect(history).toEqual([expect.objectContaining({ change: 'edited', reason: `edited by ${CHAT_LABEL}` })]);

    const repeat = await call(server, 'update-memory', { id, category: 'fact' }, asService);
    expect(repeat.data.changed_by).toBe(CHAT_LABEL);
  });
});

describe('expire-memory', () => {
  it('marks a memory a chat client retires or reactivates', async () => {
    const { server } = setup();
    const id = await ownerMemory(server);

    const retired = await call(server, 'expire-memory', { id, reason: 'contradicted' }, asChat);
    expect(retired.data).toMatchObject({ expire_reason: 'contradicted', changed_by: CHAT_LABEL });

    const other = await ownerMemory(server, 'Beta is on hold');
    await call(server, 'expire-memory', { id: other, reason: 'contradicted' });
    // Already retired by the owner: a chat client's repeat changes nothing, so it leaves no mark.
    const again = await call(server, 'expire-memory', { id: other, reason: 'contradicted' }, asChat);
    expect(again.data).toMatchObject({ already_expired: true, changed_by: null });

    const back = await call(server, 'expire-memory', { id: other, reason: 'still true', reactivate: true }, asChat);
    expect(back.data).toMatchObject({ reactivated: true, changed_by: CHAT_LABEL });
  });

  it('logs a purge by a chat client, which leaves no row to mark', async () => {
    const { db: database, server } = setup();
    const id = await ownerMemory(server);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const purged = await call(server, 'expire-memory', { id, purge: true, confirm: true }, asChat);
    expect(purged.ok).toBe(true);
    expect(getMemoryRow(database, id)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(`[memories] memory ${id} (source "owner") purged by ${CHAT_LABEL}`);

    warn.mockClear();
    const second = await ownerMemory(server, 'Beta is on hold');
    await call(server, 'expire-memory', { id: second, purge: true, confirm: true }, asService);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('the column', () => {
  it('is added once to a database that predates it, leaving existing memories unmarked', () => {
    db = new Database(':memory:');
    db.exec('CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, content TEXT NOT NULL)');
    db.prepare("INSERT INTO memories (source, content) VALUES ('owner', 'Alpha ships in March')").run();
    upgradeToMemoryChangedBy(db);
    upgradeToMemoryChangedBy(db);
    expect(db.prepare('SELECT source, changed_by FROM memories').all()).toEqual([{ source: 'owner', changed_by: null }]);
  });
});

describe('the memory note', () => {
  it('shows the client after the source, and only on a memory a chat client wrote', async () => {
    const { service, server } = setup();
    const id = await ownerMemory(server);
    const untouched = renderMemoryNote(service.snapshotAll(), []).bytes;
    expect(untouched).not.toContain('changed_by');

    await call(server, 'update-memory', { id, content: 'Alpha ships in April', evidence: EV }, asChat);
    const snapshot = service.snapshotAll();
    const rendered = renderMemoryNote(snapshot, []).bytes;
    expect(rendered).toMatch(/^source: owner\nchanged_by: client 3f8a5c2e "Chat App"$/m);
    // One block (the new version) carries it; the version it replaced does not.
    expect(rendered.match(/^changed_by:/gm)).toHaveLength(1);
    expect(Object.keys(rowToPayload(snapshot.find((r) => r.id === id)!))).not.toContain('changed_by');

    // The note reads back as an unchanged echo of the database.
    const parsed = parseMemoryNote(rendered);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const plan = validateParsedMemoryNote(parsed, snapshot);
    expect(plan).toMatchObject({ ok: true });
    if (plan.ok) expect(plan.ops.every((op) => op.kind === 'noop')).toBe(true);
  });

  it('treats the line as read-only', async () => {
    const { service, server } = setup();
    const id = await ownerMemory(server);
    await call(server, 'update-memory', { id, content: 'Alpha ships in April', evidence: EV }, asChat);
    const snapshot = service.snapshotAll();
    const rendered = renderMemoryNote(snapshot, []).bytes;

    for (const edited of [
      rendered.replace(/^changed_by: .*\n/m, ''),
      rendered.replace(/^changed_by: .*$/m, 'changed_by: the owner'),
    ]) {
      const parsed = parseMemoryNote(edited);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      const plan = validateParsedMemoryNote(parsed, snapshot);
      expect(plan).toMatchObject({ ok: false, errors: [expect.objectContaining({ message: expect.stringContaining('"changed_by"') })] });
    }
  });
});
