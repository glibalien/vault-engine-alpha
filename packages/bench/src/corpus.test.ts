import { unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { extractTurns, replayable, type CorpusTurn } from './corpus.js';

const MESSAGES_DDL = `
  CREATE TABLE messages (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    seq             INTEGER NOT NULL,
    role            TEXT NOT NULL,
    message_json    TEXT NOT NULL,
    PRIMARY KEY (conversation_id, seq)
  )
`;

const CONVERSATIONS_DDL = `
  CREATE TABLE conversations (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    archived    INTEGER NOT NULL DEFAULT 0
  , client_state TEXT)
`;

interface FixtureMessage {
  seq: number;
  role: string;
  message: unknown;
}

function insertConversation(
  db: Database.Database,
  conv: { id: string; updatedAt?: string; clientState?: string | null },
  messages: FixtureMessage[]
): void {
  db.prepare(
    'INSERT INTO conversations (id, title, created_at, updated_at, archived, client_state) VALUES (?, ?, ?, ?, 0, ?)'
  ).run(conv.id, `title-${conv.id}`, '2026-07-01T00:00:00.000Z', conv.updatedAt ?? '2026-07-01T00:00:00.000Z', conv.clientState ?? null);

  const insertMsg = db.prepare(
    'INSERT INTO messages (conversation_id, seq, role, message_json) VALUES (?, ?, ?, ?)'
  );
  for (const m of messages) {
    insertMsg.run(conv.id, m.seq, m.role, JSON.stringify(m.message));
  }
}

function dynamicTool(toolName: string, state: string, extra: Record<string, unknown> = {}) {
  return { type: 'dynamic-tool', toolName, toolCallId: `call-${toolName}-${state}`, state, ...extra };
}

describe('extractTurns / replayable', () => {
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    dbPath = join(tmpdir(), `corpus-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db = new Database(dbPath);
    db.exec(CONVERSATIONS_DDL);
    db.exec(MESSAGES_DDL);
  });

  afterEach(() => {
    db.close();
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  it('a 0-call assistant turn classifies as trivial, and history is messages[0..seq-1] verbatim including a data-viz part', () => {
    const dataVizPart = {
      type: 'data-viz',
      id: 'call_viz1',
      data: { toolCallId: 'call_viz1', spec: { kind: 'table', title: 'nodes' }, collapsed: true },
    };
    const userMsg0 = { id: 'u0', role: 'user', parts: [{ type: 'text', text: 'hello', state: 'done' }] };
    const assistantMsg1 = {
      id: 'a1',
      role: 'assistant',
      parts: [dataVizPart, { type: 'text', text: 'here you go', state: 'done' }],
    };
    const userMsg2 = { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'please update it', state: 'done' }] };
    const assistantMsg3 = {
      id: 'a3',
      role: 'assistant',
      parts: [dynamicTool('update-node', 'output-available', { input: {}, output: { ok: true } })],
    };

    insertConversation(db, { id: 'conv-1' }, [
      { seq: 0, role: 'user', message: userMsg0 },
      { seq: 1, role: 'assistant', message: assistantMsg1 },
      { seq: 2, role: 'user', message: userMsg2 },
      { seq: 3, role: 'assistant', message: assistantMsg3 },
    ]);
    db.close();

    const turns = extractTurns(dbPath);
    expect(turns).toHaveLength(2);

    const turnA = turns.find((t) => t.seq === 1);
    expect(turnA).toBeDefined();
    expect(turnA!.turnClass).toBe('trivial');
    expect(turnA!.recordedCalls).toEqual([]);
    expect(turnA!.partial).toBe(false);
    expect(turnA!.unknownTools).toEqual([]);
    expect(turnA!.modelRef).toBeNull(); // no client_state row → default coerceContext, no modelRef
    // no client_state row → coerceContext's documented defaults, carried verbatim
    expect(turnA!.contextState).toEqual({ doc: true, board: true, nodes: [] });

    const turnB = turns.find((t) => t.seq === 3);
    expect(turnB).toBeDefined();
    expect(turnB!.turnClass).toBe('single-write');
    expect(turnB!.recordedCalls).toEqual([{ toolName: 'update-node', state: 'output-available' }]);
    // history is messages[0..seq-1] verbatim — deep-equal including the data-viz part, unstripped.
    expect(turnB!.history).toEqual([userMsg0, assistantMsg1, userMsg2]);
  });

  it('a 15-call read turn classifies as complex', () => {
    const parts = Array.from({ length: 15 }, () => dynamicTool('query-nodes', 'output-available', { input: {}, output: {} }));
    insertConversation(db, { id: 'conv-complex' }, [
      { seq: 0, role: 'user', message: { id: 'u0', role: 'user', parts: [{ type: 'text', text: 'go', state: 'done' }] } },
      { seq: 1, role: 'assistant', message: { id: 'a1', role: 'assistant', parts } },
    ]);
    db.close();

    const turns = extractTurns(dbPath);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.turnClass).toBe('complex');
    expect(turns[0]!.recordedCalls).toHaveLength(15);
  });

  it('a 2-read turn classifies as multi-read', () => {
    const parts = [
      dynamicTool('get-node', 'output-available', { input: {}, output: {} }),
      dynamicTool('query-nodes', 'output-available', { input: {}, output: {} }),
    ];
    insertConversation(db, { id: 'conv-multiread' }, [
      { seq: 0, role: 'user', message: { id: 'u0', role: 'user', parts: [{ type: 'text', text: 'go', state: 'done' }] } },
      { seq: 1, role: 'assistant', message: { id: 'a1', role: 'assistant', parts } },
    ]);
    db.close();

    const turns = extractTurns(dbPath);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.turnClass).toBe('multi-read');
  });

  it('a turn with an input-streaming part is partial and excluded from replay', () => {
    const parts = [dynamicTool('create-node', 'input-streaming', { input: undefined })];
    insertConversation(db, { id: 'conv-partial' }, [
      { seq: 0, role: 'user', message: { id: 'u0', role: 'user', parts: [{ type: 'text', text: 'go', state: 'done' }] } },
      { seq: 1, role: 'assistant', message: { id: 'a1', role: 'assistant', parts } },
    ]);
    db.close();

    const turns = extractTurns(dbPath);
    expect(turns).toHaveLength(1);
    const t = turns[0]!;
    expect(t.partial).toBe(true);
    expect(t.recordedCalls).toEqual([]); // non-terminal call is not "recorded"
    expect(replayable(t)).toBe(false);
  });

  it('a turn containing an unknown-kind tool (create-wiki) is flagged and excluded from replay', () => {
    const parts = [dynamicTool('create-wiki', 'output-available', { input: {}, output: {} })];
    insertConversation(db, { id: 'conv-unknown' }, [
      { seq: 0, role: 'user', message: { id: 'u0', role: 'user', parts: [{ type: 'text', text: 'go', state: 'done' }] } },
      { seq: 1, role: 'assistant', message: { id: 'a1', role: 'assistant', parts } },
    ]);
    db.close();

    const turns = extractTurns(dbPath);
    expect(turns).toHaveLength(1);
    const t = turns[0]!;
    expect(t.unknownTools).toEqual(['create-wiki']);
    expect(t.partial).toBe(false);
    expect(replayable(t)).toBe(false);
  });

  it('a typed tool-web_search part with state output-error is counted as a recorded call', () => {
    const parts = [{ type: 'tool-web_search', toolCallId: 'call-ws', state: 'output-error', errorText: 'boom' }];
    insertConversation(db, { id: 'conv-typed-error' }, [
      { seq: 0, role: 'user', message: { id: 'u0', role: 'user', parts: [{ type: 'text', text: 'go', state: 'done' }] } },
      { seq: 1, role: 'assistant', message: { id: 'a1', role: 'assistant', parts } },
    ]);
    db.close();

    const turns = extractTurns(dbPath);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.recordedCalls).toEqual([{ toolName: 'web_search', state: 'output-error' }]);
  });

  it('extracts modelRef from client_state via coerceContext', () => {
    insertConversation(
      db,
      { id: 'conv-modelref', clientState: '{"doc":true,"board":true,"nodes":[],"modelRef":"Qwen 3.7 Plus"}' },
      [
        { seq: 0, role: 'user', message: { id: 'u0', role: 'user', parts: [{ type: 'text', text: 'go', state: 'done' }] } },
        { seq: 1, role: 'assistant', message: { id: 'a1', role: 'assistant', parts: [] } },
      ]
    );
    db.close();

    const turns = extractTurns(dbPath);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.modelRef).toBe('Qwen 3.7 Plus');
  });

  it('carries the whole coerceContext-parsed client_state as contextState (not just modelRef)', () => {
    insertConversation(
      db,
      {
        id: 'conv-ctx',
        clientState: '{"doc":false,"board":true,"nodes":["n1","n2",7],"activeBoardId":"b-42","modelRef":"Kimi K2.6"}',
      },
      [
        { seq: 0, role: 'user', message: { id: 'u0', role: 'user', parts: [{ type: 'text', text: 'go', state: 'done' }] } },
        { seq: 1, role: 'assistant', message: { id: 'a1', role: 'assistant', parts: [] } },
        { seq: 2, role: 'user', message: { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'more', state: 'done' }] } },
        { seq: 3, role: 'assistant', message: { id: 'a3', role: 'assistant', parts: [] } },
      ]
    );
    db.close();

    const turns = extractTurns(dbPath);
    expect(turns).toHaveLength(2);
    // non-string node ids are dropped by coerceContext — proof this went through it, not JSON.parse
    const expected = { doc: false, board: true, nodes: ['n1', 'n2'], activeBoardId: 'b-42', modelRef: 'Kimi K2.6' };
    expect(turns[0]!.contextState).toEqual(expected);
    // every turn of the conversation carries it
    expect(turns[1]!.contextState).toEqual(expected);
  });

  it('carries conversationUpdatedAt through onto every turn from that conversation', () => {
    insertConversation(db, { id: 'conv-updated', updatedAt: '2026-06-15T12:00:00.000Z' }, [
      { seq: 0, role: 'user', message: { id: 'u0', role: 'user', parts: [{ type: 'text', text: 'go', state: 'done' }] } },
      { seq: 1, role: 'assistant', message: { id: 'a1', role: 'assistant', parts: [] } },
    ]);
    db.close();

    const turns = extractTurns(dbPath);
    expect(turns[0]!.conversationUpdatedAt).toBe('2026-06-15T12:00:00.000Z');
    expect(turns[0]!.conversationId).toBe('conv-updated');
  });

  it('skips non-assistant rows (including a defensive "unknown" role) when selecting turns', () => {
    insertConversation(db, { id: 'conv-roles' }, [
      { seq: 0, role: 'user', message: { id: 'u0', role: 'user', parts: [] } },
      { seq: 1, role: 'unknown', message: { id: 'x1', role: 'unknown', parts: [] } },
      { seq: 2, role: 'assistant', message: { id: 'a2', role: 'assistant', parts: [] } },
    ]);
    db.close();

    const turns = extractTurns(dbPath);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.seq).toBe(2);
  });

  it('throws naming conversation_id and seq on malformed message_json', () => {
    db.prepare(
      'INSERT INTO conversations (id, title, created_at, updated_at, archived, client_state) VALUES (?, ?, ?, ?, 0, NULL)'
    ).run('conv-bad', 'title', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
    db.prepare('INSERT INTO messages (conversation_id, seq, role, message_json) VALUES (?, ?, ?, ?)').run(
      'conv-bad',
      0,
      'assistant',
      '{not valid json'
    );
    db.close();

    expect(() => extractTurns(dbPath)).toThrow(/conv-bad/);
    expect(() => extractTurns(dbPath)).toThrow(/0/);
  });
});
