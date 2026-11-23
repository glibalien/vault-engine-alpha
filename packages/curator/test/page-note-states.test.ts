import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import { deletePageNoteStates, pageNoteEntries, readPageNoteStates, writePageNoteStates, type PageNoteState } from '../src/db/page-note-states.js';

describe('page note states (#352)', () => {
  it('records what each page was built from, reads it back, and forgets a removed project', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    writePageNoteStates(db, 'Atlas', '2026-11-09T10:00:00.000Z', [{ pageId: 'p1', notes: { n1: 'h1' } }, { pageId: 'p2', notes: {} }]);
    writePageNoteStates(db, 'Other', '2026-11-09T10:00:00.000Z', [{ pageId: 'q1', notes: { n9: 'h9' } }]);
    db.prepare("INSERT INTO wiki_page_note_states VALUES ('bad', 'Atlas', 't', 'not json')").run();
    const read = readPageNoteStates(db, ['p1', 'p2', 'bad', 'missing']);
    expect([...read.keys()]).toEqual(['p1', 'p2']);
    expect(read.get('p1')).toEqual({ project: 'Atlas', builtAt: '2026-11-09T10:00:00.000Z', notes: { n1: 'h1' } });
    deletePageNoteStates(db, 'Atlas');
    expect([...readPageNoteStates(db, ['p1', 'q1']).keys()]).toEqual(['q1']);
    db.close();
  });

  it('replaces a fully synthesized page\'s record and adds to a rewritten page\'s', () => {
    const prior = new Map<string, PageNoteState>([['p1', { project: 'Atlas', builtAt: 't0', notes: { old: 'h0', n1: 'h1-old' } }],
      ['p2', { project: 'Atlas', builtAt: 't0', notes: { old: 'h0' } }]]);
    expect(pageNoteEntries({ written: ['p1', 'p2', 'p1'], rewritten: ['p1'], notes: { n1: 'h1', n2: 'h2' } }, prior)).toEqual([
      { pageId: 'p1', notes: { old: 'h0', n1: 'h1', n2: 'h2' } },
      { pageId: 'p2', notes: { n1: 'h1', n2: 'h2' } },
    ]);
  });

  it('records only the notes a page read when the planner named its sources (#474 idea 3)', () => {
    const prior = new Map<string, PageNoteState>([['p1', { project: 'Atlas', builtAt: 't0', notes: { old: 'h0' } }]]);
    expect(pageNoteEntries({ written: ['p1', 'p2', 'p3'], rewritten: ['p1'], notes: { n1: 'h1', n2: 'h2' },
      pageNotes: { p1: ['n2'], p2: ['n1', 'gone'] } }, prior)).toEqual([
      { pageId: 'p1', notes: { old: 'h0', n2: 'h2' } },
      { pageId: 'p2', notes: { n1: 'h1' } },
      { pageId: 'p3', notes: { n1: 'h1', n2: 'h2' } },
    ]);
  });
});
