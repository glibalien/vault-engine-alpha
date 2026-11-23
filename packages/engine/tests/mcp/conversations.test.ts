import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { upgradeConversationsStore, upgradeConversationLinks } from '../../src/conversations/store.js';
import { registerConversationTools } from '../../src/mcp/tools/conversations.js';

interface Envelope { ok: boolean; data?: unknown; error?: { code: string; message: string }; warnings: unknown[]; }
function parse(result: { content: Array<{ type: string; text: string }> }): Envelope {
  return JSON.parse(result.content[0].text) as Envelope;
}

let db: Database.Database;
let handlers: Map<string, (args: Record<string, unknown>) => unknown>;
function call(name: string, args: Record<string, unknown>) {
  return handlers.get(name)!(args) as Promise<{ content: Array<{ type: string; text: string }> }>;
}

beforeEach(() => {
  db = createTestDb();
  upgradeConversationsStore(db);
  upgradeConversationLinks(db);
  handlers = new Map();
  const fakeServer = {
    tool: (name: string, _desc: string, _schema: unknown, handler: (...a: unknown[]) => unknown) => {
      handlers.set(name, (args) => handler(args));
    },
  } as unknown as McpServer;
  registerConversationTools(fakeServer, db);
});

describe('conversation MCP tools', () => {
  it('save → get round-trips (with linked_docs); list shows it', async () => {
    await call('save-conversation', { id: 'c1', title: 'Hi', messages: [{ id: 'm1', role: 'user', parts: [] }] });
    const got = parse(await call('get-conversation', { id: 'c1' }));
    expect(got.ok).toBe(true);
    expect((got.data as any).conversation.title).toBe('Hi');
    expect((got.data as any).messages).toHaveLength(1);
    expect((got.data as any).linked_docs).toEqual([]);
    const list = parse(await call('list-conversations', {}));
    expect((list.data as any).conversations.map((c: { id: string }) => c.id)).toContain('c1');
  });

  it('list-conversations projects linked docs only when requested, including archived rows', async () => {
    await call('save-conversation', { id: 'c1', title: 'Active', messages: [] });
    await call('save-conversation', { id: 'c2', title: 'Archived', messages: [] });
    await call('link-conversation', { conversation_id: 'c1', doc_node_id: 'node-z' });
    await call('link-conversation', { conversation_id: 'c1', doc_node_id: 'node-a' });
    await call('link-conversation', { conversation_id: 'c2', doc_node_id: 'node-b' });
    await call('archive-conversation', { id: 'c2' });

    const defaultList = (parse(await call('list-conversations', {})).data as any).conversations;
    expect(defaultList).toHaveLength(1);
    expect(defaultList[0]).not.toHaveProperty('linked_docs');

    const withLinkedDocs = (parse(await call('list-conversations', { include_linked_docs: true })).data as any).conversations;
    expect(withLinkedDocs).toHaveLength(1);
    expect(withLinkedDocs[0].linked_docs).toEqual(['node-a', 'node-z']);

    const includingArchived = (parse(await call('list-conversations', { include_archived: true, include_linked_docs: true })).data as any).conversations;
    expect(includingArchived).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'c1', linked_docs: ['node-a', 'node-z'] }),
      expect.objectContaining({ id: 'c2', linked_docs: ['node-b'] }),
    ]));
  });

  it('link and unlink advance updated_at only when the association changes', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-22T00:00:00.000Z'));
      await call('save-conversation', { id: 'c1', title: 'Chat', messages: [] });

      vi.setSystemTime(new Date('2026-06-22T01:00:00.000Z'));
      await call('link-conversation', { conversation_id: 'c1', doc_node_id: 'node-1' });
      expect((parse(await call('get-conversation', { id: 'c1' })).data as any).conversation.updated_at).toBe('2026-06-22T01:00:00.000Z');

      vi.setSystemTime(new Date('2026-06-22T02:00:00.000Z'));
      await call('link-conversation', { conversation_id: 'c1', doc_node_id: 'node-1' });
      expect((parse(await call('get-conversation', { id: 'c1' })).data as any).conversation.updated_at).toBe('2026-06-22T01:00:00.000Z');

      vi.setSystemTime(new Date('2026-06-22T03:00:00.000Z'));
      await call('link-conversation', { conversation_id: 'c1', doc_node_id: 'node-1', linked: false });
      expect((parse(await call('get-conversation', { id: 'c1' })).data as any).conversation.updated_at).toBe('2026-06-22T03:00:00.000Z');

      vi.setSystemTime(new Date('2026-06-22T04:00:00.000Z'));
      await call('link-conversation', { conversation_id: 'c1', doc_node_id: 'node-1', linked: false });
      expect((parse(await call('get-conversation', { id: 'c1' })).data as any).conversation.updated_at).toBe('2026-06-22T03:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('save-conversation stores provided created_at/updated_at; omitting them stamps now', async () => {
    const ORIG_CREATED = '2025-01-01T00:00:00.000Z';
    const ORIG_UPDATED = '2025-03-15T12:30:00.000Z';
    await call('save-conversation', { id: 'mig1', title: 'Migrated', messages: [], created_at: ORIG_CREATED, updated_at: ORIG_UPDATED });
    const got = parse(await call('get-conversation', { id: 'mig1' }));
    expect((got.data as any).conversation.created_at).toBe(ORIG_CREATED);
    expect((got.data as any).conversation.updated_at).toBe(ORIG_UPDATED);
    // Omitting the timestamps stamps now (a real ISO instant, not the migration values).
    await call('save-conversation', { id: 'mig2', title: 'Fresh', messages: [] });
    const fresh = parse(await call('get-conversation', { id: 'mig2' }));
    const c = (fresh.data as any).conversation;
    expect(c.created_at).not.toBe(ORIG_CREATED);
    expect(c.created_at).toBe(c.updated_at);
    expect(Number.isNaN(Date.parse(c.created_at))).toBe(false);
  });

  it.each(['', '   '])('save-conversation and set-conversation-state refuse a blank id (%j) without writing', async (id) => {
    const saved = parse(await call('save-conversation', { id, title: 'Blank', messages: [] }));
    expect(saved).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
    const state = parse(await call('set-conversation-state', { id, client_state: { draft: true } }));
    expect(state).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversations').get()).toEqual({ n: 0 });
  });

  it('delete-conversation still removes a stored blank-id row', async () => {
    db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at, archived) VALUES ('', 'Blank', 'T', 'T', 0)`).run();
    expect(parse(await call('delete-conversation', { id: '' }))).toMatchObject({ ok: true, data: { deleted: true } });
  });

  it('get-conversation unknown id → NOT_FOUND', async () => {
    const r = parse(await call('get-conversation', { id: 'nope' }));
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('NOT_FOUND');
  });

  it('link-conversation on an unknown conversation → NOT_FOUND', async () => {
    const r = parse(await call('link-conversation', { conversation_id: 'nope', doc_node_id: 'node-1' }));
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('NOT_FOUND');
  });

  it('link → list-conversations by doc resolves it; get-conversation shows linked_docs; linked:false removes it', async () => {
    await call('save-conversation', { id: 'c1', title: '1', messages: [] });
    expect((parse(await call('link-conversation', { conversation_id: 'c1', doc_node_id: 'node-1' })).data as any).linked).toBe(true);
    expect((parse(await call('link-conversation', { conversation_id: 'c1', doc_node_id: 'node-1' })).data as any).linked).toBe(false); // idempotent
    expect((parse(await call('get-conversation', { id: 'c1' })).data as any).linked_docs).toEqual(['node-1']);
    expect((parse(await call('list-conversations', { doc_node_id: 'node-1' })).data as any).conversations.map((c: { id: string }) => c.id)).toEqual(['c1']);
    expect((parse(await call('list-conversations', { doc_node_id: 'none' })).data as any).conversations).toEqual([]);
    expect((parse(await call('link-conversation', { conversation_id: 'c1', doc_node_id: 'node-1', linked: false })).data as any).unlinked).toBe(true);
    expect((parse(await call('get-conversation', { id: 'c1' })).data as any).linked_docs).toEqual([]);
  });

  it('list-conversations by doc honours include_archived and include_linked_docs', async () => {
    await call('save-conversation', { id: 'c1', title: '1', messages: [] });
    await call('link-conversation', { conversation_id: 'c1', doc_node_id: 'node-1' });
    await call('archive-conversation', { id: 'c1' });
    expect((parse(await call('list-conversations', { doc_node_id: 'node-1' })).data as any).conversations).toHaveLength(0);
    expect((parse(await call('list-conversations', { doc_node_id: 'node-1', include_archived: true })).data as any).conversations).toHaveLength(1);
    await call('link-conversation', { conversation_id: 'c1', doc_node_id: 'node-2' });
    expect((parse(await call('list-conversations', { doc_node_id: 'node-1', include_archived: true, include_linked_docs: true })).data as any).conversations[0].linked_docs).toEqual(['node-1', 'node-2']);
  });

  it('archive hides from default list; delete removes', async () => {
    await call('save-conversation', { id: 'c1', title: '1', messages: [] });
    expect((parse(await call('archive-conversation', { id: 'c1' })).data as any).archived).toBe(true);
    expect((parse(await call('list-conversations', {})).data as any).conversations).toHaveLength(0);
    await call('save-conversation', { id: 'c2', title: '2', messages: [] });
    expect((parse(await call('delete-conversation', { id: 'c2' })).data as any).deleted).toBe(true);
  });
});

describe('conversation MCP tools — client_state + unarchive', () => {
  it('save-conversation persists client_state and get-conversation returns it', async () => {
    await call('save-conversation', { id: 'k1', title: 'T', messages: [{ id: 'm1', role: 'user', parts: [] }], client_state: { doc: true, board: false, nodes: [] } });
    const got = parse(await call('get-conversation', { id: 'k1' }));
    expect((got.data as any).client_state).toEqual({ doc: true, board: false, nodes: [] });
  });

  it('save-conversation without client_state preserves the existing blob', async () => {
    await call('save-conversation', { id: 'k1b', title: 'T', messages: [], client_state: { nodes: ['keep'] } });
    await call('save-conversation', { id: 'k1b', messages: [{ id: 'm', role: 'user', parts: [] }] });
    const got = parse(await call('get-conversation', { id: 'k1b' }));
    expect((got.data as any).client_state).toEqual({ nodes: ['keep'] });
    expect((got.data as any).messages).toHaveLength(1);
  });

  it('set-conversation-state updates client_state; unknown id upserts the conversation', async () => {
    await call('save-conversation', { id: 'k2', title: 'T', messages: [] });
    const r = parse(await call('set-conversation-state', { id: 'k2', client_state: { nodes: ['x'] } }));
    expect(r.ok).toBe(true);
    expect((parse(await call('get-conversation', { id: 'k2' })).data as any).client_state).toEqual({ nodes: ['x'] });
    // Unknown id → upsert creates the conversation carrying the state (pre-first-message window).
    const created = parse(await call('set-conversation-state', { id: 'fresh', client_state: { doc: false } }));
    expect(created.ok).toBe(true);
    const got = parse(await call('get-conversation', { id: 'fresh' }));
    expect(got.ok).toBe(true);
    expect((got.data as any).client_state).toEqual({ doc: false });
  });

  it('archive-conversation archived:false un-hides an archived conversation', async () => {
    await call('save-conversation', { id: 'k3', title: 'T', messages: [] });
    await call('archive-conversation', { id: 'k3' });
    expect((parse(await call('list-conversations', {})).data as any).conversations.map((c: { id: string }) => c.id)).not.toContain('k3');
    expect((parse(await call('archive-conversation', { id: 'k3', archived: false })).data as any).unarchived).toBe(true);
    expect((parse(await call('list-conversations', {})).data as any).conversations.map((c: { id: string }) => c.id)).toContain('k3');
  });
});
