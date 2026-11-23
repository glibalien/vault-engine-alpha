import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';

export interface BoardCard { card_id: string; spec: unknown; layout: { width?: number; height?: number; order: number } }
export interface Board { id: string; name: string; cards: BoardCard[]; created_at: number; updated_at: number; linked_docs: string[] }
export interface BoardSummary { id: string; name: string; created_at: number; updated_at: number; card_count: number }

export { upgradeBoardsStore, upgradeBoardLinksStore, resetBoardsAfterSingleViewSplit } from '../db/migrate.js';

export function listBoards(db: Database.Database): BoardSummary[] {
  const rows = db.prepare('SELECT id, name, cards_json, created_at, updated_at FROM boards ORDER BY updated_at DESC').all() as
    Array<{ id: string; name: string; cards_json: string; created_at: number; updated_at: number }>;
  return rows.map(toSummary);
}

export function getBoard(db: Database.Database, id: string): Board | null {
  const row = db.prepare('SELECT id, name, cards_json, created_at, updated_at FROM boards WHERE id = ?').get(id) as
    { id: string; name: string; cards_json: string; created_at: number; updated_at: number } | undefined;
  if (!row) return null;
  return { id: row.id, name: row.name, cards: JSON.parse(row.cards_json) as BoardCard[], created_at: row.created_at, updated_at: row.updated_at, linked_docs: listDocsForBoard(db, id) };
}

/** Creates a board (no id) or replaces an existing one's name and cards. Returns null when the
 *  id names no board: a board deleted elsewhere is never recreated by a later save from a client
 *  still showing it, which would bring it back without its note links (#304). */
export function saveBoard(db: Database.Database, input: { id?: undefined; name: string; cards: BoardCard[] }, now: number): { id: string };
export function saveBoard(db: Database.Database, input: { id?: string; name: string; cards: BoardCard[] }, now: number): { id: string } | null;
export function saveBoard(db: Database.Database, input: { id?: string; name: string; cards: BoardCard[] }, now: number): { id: string } | null {
  const cards_json = JSON.stringify(input.cards);
  if (input.id !== undefined) {
    const changed = db.prepare('UPDATE boards SET name = ?, cards_json = ?, updated_at = ? WHERE id = ?').run(input.name, cards_json, now, input.id).changes;
    return changed > 0 ? { id: input.id } : null;
  }
  const id = nanoid();
  db.prepare('INSERT INTO boards (id, name, cards_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, input.name, cards_json, now, now);
  return { id };
}

export function deleteBoard(db: Database.Database, id: string): boolean {
  // Explicit cascade alongside the FK ON DELETE CASCADE (belt-and-braces).
  db.prepare('DELETE FROM board_links WHERE board_id = ?').run(id);
  return db.prepare('DELETE FROM boards WHERE id = ?').run(id).changes > 0;
}

// --- board↔doc associations (Phase 4b) -----------------------------------

/** Associate a board with a doc (by node id). Idempotent: re-link → linked:false. */
export function linkBoardToDoc(db: Database.Database, board_id: string, doc_node_id: string, now: number): { linked: boolean } {
  const res = db.prepare('INSERT OR IGNORE INTO board_links (board_id, doc_node_id, created_at) VALUES (?, ?, ?)').run(board_id, doc_node_id, now);
  return { linked: res.changes > 0 };
}

export function unlinkBoardFromDoc(db: Database.Database, board_id: string, doc_node_id: string): { unlinked: boolean } {
  const res = db.prepare('DELETE FROM board_links WHERE board_id = ? AND doc_node_id = ?').run(board_id, doc_node_id);
  return { unlinked: res.changes > 0 };
}

/** Boards linked to a doc, most-recently-updated first. */
export function listBoardsForDoc(db: Database.Database, doc_node_id: string): BoardSummary[] {
  const rows = db.prepare(
    `SELECT b.id, b.name, b.cards_json, b.created_at, b.updated_at
       FROM boards b JOIN board_links l ON l.board_id = b.id
      WHERE l.doc_node_id = ? ORDER BY b.updated_at DESC`,
  ).all(doc_node_id) as Array<{ id: string; name: string; cards_json: string; created_at: number; updated_at: number }>;
  return rows.map(toSummary);
}

/** Doc node ids a board is linked to (oldest link first). */
export function listDocsForBoard(db: Database.Database, board_id: string): string[] {
  return (db.prepare('SELECT doc_node_id FROM board_links WHERE board_id = ? ORDER BY created_at').all(board_id) as Array<{ doc_node_id: string }>)
    .map((r) => r.doc_node_id);
}

function toSummary(r: { id: string; name: string; cards_json: string; created_at: number; updated_at: number }): BoardSummary {
  return { id: r.id, name: r.name, created_at: r.created_at, updated_at: r.updated_at, card_count: safeLen(r.cards_json) };
}

function safeLen(json: string): number {
  try { const a = JSON.parse(json); return Array.isArray(a) ? a.length : 0; } catch { return 0; }
}
