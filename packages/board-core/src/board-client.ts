import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Board, BoardSummary, SaveBoardInput, CallFn } from './types.js';

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

/** A board tool's refusal, with the Engine's error code (e.g. NOT_FOUND for a deleted board). */
export class BoardToolError extends Error {
  override readonly name = 'BoardToolError';
  constructor(readonly code: string, message: string) { super(message); }
}

/** The board no longer exists: deleted elsewhere (#304). */
export function isBoardNotFound(error: unknown): boolean {
  return error instanceof BoardToolError && error.code === 'NOT_FOUND';
}

function parseEnvelope<T>(result: CallToolResult): Envelope<T> {
  const first = result.content?.[0] as { type: string; text?: string } | undefined;
  if (typeof first?.text !== 'string') throw new Error('Board tool result missing text content');
  return JSON.parse(first.text) as Envelope<T>;
}

export interface BoardClient {
  list(): Promise<BoardSummary[]>;
  get(id: string): Promise<Board | null>;
  save(input: SaveBoardInput): Promise<{ id: string }>;
  remove(id: string): Promise<boolean>;
  linkToDoc(boardId: string, docNodeId: string): Promise<boolean>;
  unlinkFromDoc(boardId: string, docNodeId: string): Promise<boolean>;
  listForDoc(docNodeId: string): Promise<BoardSummary[]>;
}

export function makeBoardClient(call: CallFn): BoardClient {
  return {
    async list() {
      const env = parseEnvelope<{ boards: BoardSummary[] }>(await call({ name: 'list-boards', arguments: {} }));
      return env.data?.boards ?? [];
    },
    async get(id: string) {
      const env = parseEnvelope<Board>(await call({ name: 'get-board', arguments: { id } }));
      if (!env.ok) return null;
      return env.data ?? null;
    },
    async save(input: SaveBoardInput) {
      const args: Record<string, unknown> = { name: input.name, cards: input.cards };
      if (input.id !== undefined) args.id = input.id;
      const env = parseEnvelope<{ id: string }>(await call({ name: 'save-board', arguments: args }));
      if (!env.ok || !env.data) {
        throw new BoardToolError(env.error?.code ?? 'UNKNOWN', env.error?.message ?? 'save-board failed');
      }
      return env.data;
    },
    async remove(id: string) {
      const env = parseEnvelope<{ deleted: boolean }>(await call({ name: 'delete-board', arguments: { id } }));
      return env.data?.deleted ?? false;
    },
    async linkToDoc(boardId: string, docNodeId: string) {
      const env = parseEnvelope<{ linked: boolean }>(await call({ name: 'link-board', arguments: { board_id: boardId, doc_node_id: docNodeId } }));
      return env.data?.linked ?? false;
    },
    async unlinkFromDoc(boardId: string, docNodeId: string) {
      const env = parseEnvelope<{ unlinked: boolean }>(await call({ name: 'link-board', arguments: { board_id: boardId, doc_node_id: docNodeId, linked: false } }));
      return env.data?.unlinked ?? false;
    },
    async listForDoc(docNodeId: string) {
      const env = parseEnvelope<{ boards: BoardSummary[] }>(await call({ name: 'list-boards', arguments: { doc_node_id: docNodeId } }));
      return env.data?.boards ?? [];
    },
  };
}
