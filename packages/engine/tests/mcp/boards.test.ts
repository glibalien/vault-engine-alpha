import { describe, it, expect, beforeEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { upgradeBoardsStore, upgradeBoardLinksStore } from '../../src/boards/store.js';
import { registerBoardTools } from '../../src/mcp/tools/boards.js';

interface Envelope {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
  warnings: unknown[];
}

function parse(result: { content: Array<{ type: string; text: string }> }): Envelope {
  return JSON.parse(result.content[0].text) as Envelope;
}

let db: Database.Database;
let handlers: Map<string, (args: Record<string, unknown>) => unknown>;

beforeEach(() => {
  db = createTestDb();
  upgradeBoardsStore(db);
  upgradeBoardLinksStore(db);

  handlers = new Map();
  const fakeServer = {
    tool: (name: string, _desc: string, _schema: unknown, handler: (...a: unknown[]) => unknown) => {
      handlers.set(name, (args) => handler(args));
    },
  } as unknown as McpServer;
  registerBoardTools(fakeServer, db);
});

describe('board MCP tools', () => {
  it('save-board creates a board and returns an id', async () => {
    const result = parse(await handlers.get('save-board')!({ name: 'My Board', cards: [] }) as any);
    expect(result.ok).toBe(true);
    expect(typeof (result.data as any).id).toBe('string');
    expect((result.data as any).id.length).toBeGreaterThan(0);
  });

  it('get-board round-trips name and cards', async () => {
    const cards = [{ card_id: 'c1', spec: { label: 'hi' }, layout: { order: 0 } }];
    const saveResult = parse(await handlers.get('save-board')!({ name: 'Round Trip', cards }) as any);
    expect(saveResult.ok).toBe(true);
    const id = (saveResult.data as any).id as string;

    const getResult = parse(await handlers.get('get-board')!({ id }) as any);
    expect(getResult.ok).toBe(true);
    const board = getResult.data as any;
    expect(board.name).toBe('Round Trip');
    expect(board.cards).toEqual(cards);
    expect(board.id).toBe(id);
  });

  it('get-board returns NOT_FOUND for unknown id', async () => {
    const result = parse(await handlers.get('get-board')!({ id: 'no-such-board' }) as any);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');
  });

  it('save-board rejects empty name with INVALID_PARAMS', async () => {
    const result = parse(await handlers.get('save-board')!({ name: '', cards: [] }) as any);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_PARAMS');
  });

  it('save-board rejects whitespace-only name with INVALID_PARAMS', async () => {
    const result = parse(await handlers.get('save-board')!({ name: '   ', cards: [] }) as any);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_PARAMS');
  });

  it('list-boards includes saved board with correct card_count', async () => {
    const cards = [
      { card_id: 'c1', spec: null, layout: { order: 0 } },
      { card_id: 'c2', spec: null, layout: { order: 1 } },
    ];
    await handlers.get('save-board')!({ name: 'Listed Board', cards });

    const result = parse(await handlers.get('list-boards')!({}) as any);
    expect(result.ok).toBe(true);
    const boards = (result.data as any).boards as any[];
    const found = boards.find((b: any) => b.name === 'Listed Board');
    expect(found).toBeDefined();
    expect(found.card_count).toBe(2);
    expect(typeof found.id).toBe('string');
    expect(typeof found.updated_at).toBe('number');
  });

  it('delete-board returns deleted:true and get-board then returns NOT_FOUND', async () => {
    const saveResult = parse(await handlers.get('save-board')!({ name: 'To Delete', cards: [] }) as any);
    const id = (saveResult.data as any).id as string;

    const deleteResult = parse(await handlers.get('delete-board')!({ id }) as any);
    expect(deleteResult.ok).toBe(true);
    expect((deleteResult.data as any).deleted).toBe(true);

    const getResult = parse(await handlers.get('get-board')!({ id }) as any);
    expect(getResult.ok).toBe(false);
    expect(getResult.error?.code).toBe('NOT_FOUND');
  });

  it('save-board by the id of a deleted board fails NOT_FOUND instead of recreating it (#304)', async () => {
    const id = (parse(await handlers.get('save-board')!({ name: 'Elsewhere', cards: [] }) as any).data as any).id as string;
    await handlers.get('delete-board')!({ id });
    const resave = parse(await handlers.get('save-board')!({ id, name: 'Elsewhere', cards: [] }) as any);
    expect(resave.ok).toBe(false);
    expect(resave.error?.code).toBe('NOT_FOUND');
    expect(parse(await handlers.get('get-board')!({ id }) as any).ok).toBe(false);
  });
});

describe('board↔doc association MCP tools (Phase 4b)', () => {
  async function newBoard(name = 'B'): Promise<string> {
    const r = parse(await handlers.get('save-board')!({ name, cards: [] }) as any);
    return (r.data as any).id as string;
  }

  it('link-board associates a doc; get-board reflects linked_docs; idempotent', async () => {
    const id = await newBoard();
    const first = parse(await handlers.get('link-board')!({ board_id: id, doc_node_id: 'node-1' }) as any);
    expect(first.ok).toBe(true);
    expect((first.data as any).linked).toBe(true);

    const second = parse(await handlers.get('link-board')!({ board_id: id, doc_node_id: 'node-1' }) as any);
    expect((second.data as any).linked).toBe(false); // idempotent

    const board = parse(await handlers.get('get-board')!({ id }) as any).data as any;
    expect(board.linked_docs).toEqual(['node-1']);
  });

  it('link-board returns NOT_FOUND for an unknown board', async () => {
    const result = parse(await handlers.get('link-board')!({ board_id: 'nope', doc_node_id: 'n' }) as any);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');
  });

  it('link-board linked:false removes the association', async () => {
    const id = await newBoard();
    await handlers.get('link-board')!({ board_id: id, doc_node_id: 'node-1' });
    const result = parse(await handlers.get('link-board')!({ board_id: id, doc_node_id: 'node-1', linked: false }) as any);
    expect(result.ok).toBe(true);
    expect((result.data as any).unlinked).toBe(true);
    const board = parse(await handlers.get('get-board')!({ id }) as any).data as any;
    expect(board.linked_docs).toEqual([]);
  });

  it('list-boards with doc_node_id returns only linked boards', async () => {
    const a = await newBoard('linked-a');
    const b = await newBoard('linked-b');
    await handlers.get('link-board')!({ board_id: a, doc_node_id: 'doc' });
    await handlers.get('link-board')!({ board_id: b, doc_node_id: 'doc' });
    await newBoard('unlinked'); // not linked → excluded

    const result = parse(await handlers.get('list-boards')!({ doc_node_id: 'doc' }) as any);
    expect(result.ok).toBe(true);
    const boards = (result.data as any).boards as any[];
    expect(boards.map((x) => x.id).sort()).toEqual([a, b].sort());
    // deterministic updated_at ordering is covered in boards/store.test.ts
  });

  it('delete-board cascades its links', async () => {
    const id = await newBoard();
    await handlers.get('link-board')!({ board_id: id, doc_node_id: 'doc' });
    await handlers.get('delete-board')!({ id });
    const result = parse(await handlers.get('list-boards')!({ doc_node_id: 'doc' }) as any);
    expect((result.data as any).boards).toEqual([]);
  });
});
