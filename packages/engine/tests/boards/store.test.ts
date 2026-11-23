import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { upgradeBoardsStore, upgradeBoardLinksStore, listBoards, getBoard, saveBoard, deleteBoard, linkBoardToDoc, unlinkBoardFromDoc, listBoardsForDoc, listDocsForBoard } from '../../src/boards/store.js';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); upgradeBoardsStore(db); upgradeBoardLinksStore(db); });

const card = (order: number) => ({ card_id: `c${order}`, spec: { kind: 'table', title: 't', query: {}, display_fields: [] }, layout: { order } });

describe('board store', () => {
  it('saveBoard creates with a generated id, getBoard round-trips cards opaquely', () => {
    const { id } = saveBoard(db, { name: 'My board', cards: [card(0), card(1)] }, 1000);
    expect(id).toMatch(/.+/);
    const b = getBoard(db, id);
    expect(b).toMatchObject({ id, name: 'My board', created_at: 1000, updated_at: 1000 });
    expect(b!.cards).toEqual([card(0), card(1)]); // opaque blob survives verbatim
  });

  it('saveBoard with an id replaces name+cards and bumps updated_at, preserving id', () => {
    const { id } = saveBoard(db, { name: 'A', cards: [card(0)] }, 1000);
    const { id: id2 } = saveBoard(db, { id, name: 'A renamed', cards: [card(0), card(1)] }, 2000)!;
    expect(id2).toBe(id); // id stable across rename (D8 constraint 1)
    const b = getBoard(db, id);
    expect(b!.name).toBe('A renamed');
    expect(b!.cards).toHaveLength(2);
    expect(b!.created_at).toBe(1000);
    expect(b!.updated_at).toBe(2000);
  });

  it('never recreates a deleted board from a save by id (#304)', () => {
    const { id } = saveBoard(db, { name: 'Gone', cards: [card(0)] }, 1000);
    deleteBoard(db, id);
    expect(saveBoard(db, { id, name: 'Gone', cards: [card(0)] }, 2000)).toBeNull();
    expect(getBoard(db, id)).toBeNull();
    expect(saveBoard(db, { id: 'never-existed', name: 'X', cards: [] }, 2000)).toBeNull();
  });

  it('two boards with the same name get distinct ids (D8 constraint 1)', () => {
    const a = saveBoard(db, { name: 'dup', cards: [] }, 1000);
    const b = saveBoard(db, { name: 'dup', cards: [] }, 1000);
    expect(a.id).not.toBe(b.id);
  });

  it('listBoards returns summaries ordered by updated_at desc', () => {
    const a = saveBoard(db, { name: 'old', cards: [card(0)] }, 1000);
    const b = saveBoard(db, { name: 'new', cards: [] }, 2000);
    const list = listBoards(db);
    expect(list.map((x) => x.id)).toEqual([b.id, a.id]);
    expect(list[0]).toMatchObject({ name: 'new', card_count: 0 });
    expect(list[1]).toMatchObject({ name: 'old', card_count: 1 });
  });

  it('getBoard returns null for an unknown id; deleteBoard reports found/not-found', () => {
    expect(getBoard(db, 'nope')).toBeNull();
    const { id } = saveBoard(db, { name: 'x', cards: [] }, 1000);
    expect(deleteBoard(db, id)).toBe(true);
    expect(getBoard(db, id)).toBeNull();
    expect(deleteBoard(db, id)).toBe(false);
  });

  it('upgradeBoardsStore is idempotent', () => {
    expect(() => upgradeBoardsStore(db)).not.toThrow(); // second run on same db
  });

  it('upgradeBoardLinksStore is idempotent', () => {
    expect(() => upgradeBoardLinksStore(db)).not.toThrow(); // second run on same db
  });
});

describe('board↔doc associations (Phase 4b)', () => {
  it('linkBoardToDoc is idempotent and getBoard reflects linked_docs', () => {
    const { id } = saveBoard(db, { name: 'B', cards: [] }, 1000);
    expect(linkBoardToDoc(db, id, 'node-1', 1000)).toEqual({ linked: true });
    expect(linkBoardToDoc(db, id, 'node-1', 1001)).toEqual({ linked: false }); // re-link → no-op
    expect(getBoard(db, id)!.linked_docs).toEqual(['node-1']);
    expect(listDocsForBoard(db, id)).toEqual(['node-1']);
  });

  it('unlinkBoardFromDoc reports found/not-found', () => {
    const { id } = saveBoard(db, { name: 'B', cards: [] }, 1000);
    linkBoardToDoc(db, id, 'node-1', 1000);
    expect(unlinkBoardFromDoc(db, id, 'node-1')).toEqual({ unlinked: true });
    expect(unlinkBoardFromDoc(db, id, 'node-1')).toEqual({ unlinked: false });
    expect(getBoard(db, id)!.linked_docs).toEqual([]);
  });

  it('listBoardsForDoc returns only linked boards, most-recently-updated first', () => {
    const a = saveBoard(db, { name: 'old', cards: [] }, 1000);
    const b = saveBoard(db, { name: 'new', cards: [] }, 2000);
    const c = saveBoard(db, { name: 'unlinked', cards: [] }, 3000);
    linkBoardToDoc(db, a.id, 'doc', 1000);
    linkBoardToDoc(db, b.id, 'doc', 1000);
    const list = listBoardsForDoc(db, 'doc');
    expect(list.map((x) => x.id)).toEqual([b.id, a.id]); // by updated_at desc; c excluded
  });

  it('M:N — one board to two docs, one doc to two boards', () => {
    const a = saveBoard(db, { name: 'a', cards: [] }, 1000);
    const b = saveBoard(db, { name: 'b', cards: [] }, 2000);
    linkBoardToDoc(db, a.id, 'doc-1', 1000);
    linkBoardToDoc(db, a.id, 'doc-2', 1000); // one board → two docs
    linkBoardToDoc(db, b.id, 'doc-1', 1000); // one doc → two boards
    expect(getBoard(db, a.id)!.linked_docs.sort()).toEqual(['doc-1', 'doc-2']);
    expect(listBoardsForDoc(db, 'doc-1').map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
    expect(linkBoardToDoc(db, a.id, 'doc-1', 9000).linked).toBe(false); // identity stable, no dup row
  });

  it('deleteBoard cascades its board_links rows', () => {
    const { id } = saveBoard(db, { name: 'B', cards: [] }, 1000);
    linkBoardToDoc(db, id, 'node-1', 1000);
    linkBoardToDoc(db, id, 'node-2', 1000);
    expect(deleteBoard(db, id)).toBe(true);
    expect(listBoardsForDoc(db, 'node-1')).toEqual([]);
    expect(listBoardsForDoc(db, 'node-2')).toEqual([]);
  });
});
