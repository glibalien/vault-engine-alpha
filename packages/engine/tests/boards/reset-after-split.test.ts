import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  upgradeBoardsStore, upgradeBoardLinksStore, resetBoardsAfterSingleViewSplit,
  saveBoard, listBoards, linkBoardToDoc, listBoardsForDoc,
} from '../../src/boards/store.js';
import { ensureMetaTable } from '../../src/db/migrate.js';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  upgradeBoardsStore(db);
  upgradeBoardLinksStore(db);
  ensureMetaTable(db);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

const card = (id: string, order: number) => ({ card_id: id, spec: { kind: 'table', title: id }, layout: { order } });
const marker = () => db.prepare("SELECT value FROM meta WHERE key = 'boards_single_view'").get();

describe('resetBoardsAfterSingleViewSplit', () => {
  it('leaves boards alone on a database that never ran the split', () => {
    const { id } = saveBoard(db, { name: 'Keep', cards: [card('a', 0), card('b', 1)] }, 1000);
    linkBoardToDoc(db, id, 'doc-1', 1100);
    resetBoardsAfterSingleViewSplit(db);
    expect(listBoards(db).map((b) => b.name)).toEqual(['Keep']);
    expect(listBoardsForDoc(db, 'doc-1')).toHaveLength(1);
    expect(console.log).not.toHaveBeenCalled();
    expect(db.prepare("SELECT value FROM meta WHERE key = 'boards_reset_export'").get()).toBeUndefined();
  });

  it('drops every board and link once on a split database, logs it, and forgets the marker', () => {
    const a = saveBoard(db, { name: 'Fragment A', cards: [card('a', 0)] }, 1000).id;
    const b = saveBoard(db, { name: 'Fragment B', cards: [card('b', 0)] }, 1001).id;
    linkBoardToDoc(db, a, 'doc-1', 1100);
    linkBoardToDoc(db, b, 'doc-1', 1100);
    db.prepare("INSERT INTO meta (key, value) VALUES ('boards_single_view', '1')").run();

    resetBoardsAfterSingleViewSplit(db);

    expect(listBoards(db)).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM board_links').get()).toEqual({ n: 0 });
    expect(marker()).toBeUndefined();

    // The deleted rows are kept, verbatim, as a JSON export in meta.
    const row = db.prepare("SELECT value FROM meta WHERE key = 'boards_reset_export'").get() as { value: string };
    const exported = JSON.parse(row.value) as { reset_at: string; boards: Array<Record<string, unknown>>; board_links: Array<Record<string, unknown>> };
    expect(typeof exported.reset_at).toBe('string');
    expect(exported.boards.map((b) => b.name).sort()).toEqual(['Fragment A', 'Fragment B']);
    expect(JSON.parse(exported.boards.find((b) => b.id === a)!.cards_json as string)).toEqual([card('a', 0)]);
    expect(exported.board_links).toEqual(expect.arrayContaining([
      { board_id: a, doc_node_id: 'doc-1', created_at: 1100 },
      { board_id: b, doc_node_id: 'doc-1', created_at: 1100 },
    ]));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('deleted 2 boards and 2 board links'));
  });

  it('runs once: boards saved after the reset survive the next startup', () => {
    db.prepare("INSERT INTO meta (key, value) VALUES ('boards_single_view', '1')").run();
    resetBoardsAfterSingleViewSplit(db);
    saveBoard(db, { name: 'New', cards: [card('a', 0), card('b', 1)] }, 2000);
    resetBoardsAfterSingleViewSplit(db);
    expect(listBoards(db).map((b) => b.name)).toEqual(['New']);
  });
});

describe('board summaries', () => {
  it('carry created_at and the card count', () => {
    const { id } = saveBoard(db, { name: 'K', cards: [card('a', 0), card('b', 1)] }, 1234);
    expect(listBoards(db)).toEqual([{ id, name: 'K', created_at: 1234, updated_at: 1234, card_count: 2 }]);
  });
});
