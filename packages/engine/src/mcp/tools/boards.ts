import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { listBoards, getBoard, saveBoard, deleteBoard, linkBoardToDoc, unlinkBoardFromDoc, listBoardsForDoc } from '../../boards/store.js';
import { ok, fail } from './errors.js';

const cardShape = z.object({
  card_id: z.string(),
  spec: z.unknown(),
  layout: z.object({ width: z.number().optional(), height: z.number().optional(), order: z.number() }),
});

export function registerBoardTools(server: McpServer, db: Database.Database): void {
  server.tool(
    'list-boards',
    'List saved boards (id, name, created_at, updated_at, card_count). Pass doc_node_id to list only boards associated with that document, most-recently-updated first.',
    { doc_node_id: z.string().optional() },
    async ({ doc_node_id }) => {
      try { return ok({ boards: doc_node_id === undefined ? listBoards(db) : listBoardsForDoc(db, doc_node_id) }); }
      catch (err) { return fail('INTERNAL_ERROR', err instanceof Error ? err.message : String(err)); }
    },
  );

  server.tool('get-board', 'Get a board by id, including its cards.', { id: z.string() }, async ({ id }) => {
    try {
      const board = getBoard(db, id);
      return board ? ok(board) : fail('NOT_FOUND', `no board ${id}`);
    } catch (err) { return fail('INTERNAL_ERROR', err instanceof Error ? err.message : String(err)); }
  });

  server.tool(
    'save-board',
    'Create or replace a board. Omit id to create; pass id to replace an existing board\'s name+cards (NOT_FOUND if it was deleted). Cards are stored opaquely.',
    { id: z.string().optional(), name: z.string(), cards: z.array(cardShape) },
    async ({ id, name, cards }) => {
      if (name.trim() === '') return fail('INVALID_PARAMS', 'name is required');
      try {
        const saved = saveBoard(db, { id, name: name.trim(), cards }, Date.now());
        return saved ? ok(saved) : fail('NOT_FOUND', `no board ${id}`);
      }
      catch (err) { return fail('INTERNAL_ERROR', err instanceof Error ? err.message : String(err)); }
    },
  );

  server.tool('delete-board', 'Delete a board by id.', { id: z.string() }, async ({ id }) => {
    try { return ok({ deleted: deleteBoard(db, id) }); }
    catch (err) { return fail('INTERNAL_ERROR', err instanceof Error ? err.message : String(err)); }
  });

  // --- board↔doc associations (Phase 4b) ---------------------------------

  server.tool(
    'link-board',
    'Associate a board with a document (by node id), or pass linked:false to remove the association. Idempotent. Returns {linked} or {unlinked}.',
    { board_id: z.string(), doc_node_id: z.string(), linked: z.boolean().default(true) },
    async ({ board_id, doc_node_id, linked }) => {
      try {
        if (linked === false) return ok(unlinkBoardFromDoc(db, board_id, doc_node_id));
        if (!getBoard(db, board_id)) return fail('NOT_FOUND', `no board ${board_id}`);
        return ok(linkBoardToDoc(db, board_id, doc_node_id, Date.now()));
      } catch (err) { return fail('INTERNAL_ERROR', err instanceof Error ? err.message : String(err)); }
    },
  );
}
