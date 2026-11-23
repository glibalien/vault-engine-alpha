import type Database from 'better-sqlite3';
import { z } from 'zod';

/**
 * What a project sub-page was last written from (#352): the content hash of each note the build
 * read. The next build rewrites the page from its current text plus only the notes that changed
 * since, or that it didn't read before; a page with no record, or with nothing changed, is
 * synthesized as before.
 */
export interface PageNoteState {
  project: string;
  builtAt: string;
  notes: Record<string, string>;
}

const notesSchema = z.record(z.string(), z.string());

/** DDL for migration 33. */
export function createPageNoteStatesTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE wiki_page_note_states (
      page_id    TEXT PRIMARY KEY,
      project    TEXT NOT NULL,
      built_at   TEXT NOT NULL,
      notes_json TEXT NOT NULL
    );
    CREATE INDEX idx_wiki_page_note_states_project ON wiki_page_note_states(project);
  `);
}

/** Each page's stored state, keyed by page id; pages without a readable record are left out. */
export function readPageNoteStates(db: Database.Database, pageIds: readonly string[]): Map<string, PageNoteState> {
  const out = new Map<string, PageNoteState>();
  const read = db.prepare('SELECT project, built_at, notes_json FROM wiki_page_note_states WHERE page_id = ?');
  for (const pageId of new Set(pageIds)) {
    const row = read.get(pageId) as { project: string; built_at: string; notes_json: string } | undefined;
    if (!row) continue;
    try {
      out.set(pageId, { project: row.project, builtAt: row.built_at, notes: notesSchema.parse(JSON.parse(row.notes_json)) });
    } catch {
      // Unreadable: the page is synthesized as before and gets a fresh record.
    }
  }
  return out;
}

/**
 * What to record for each page a written build wrote (#352). A page synthesized in full was built
 * from this build's notes; a rewritten page still rests on what it was built from before, plus
 * this build's notes.
 */
export function pageNoteEntries(states: { readonly written: readonly string[]; readonly rewritten: readonly string[];
  readonly notes: Readonly<Record<string, string>>; readonly pageNotes?: Readonly<Record<string, readonly string[]>> },
  prior: ReadonlyMap<string, PageNoteState>,
): Array<{ pageId: string; notes: Record<string, string> }> {
  const rewritten = new Set(states.rewritten);
  // A page whose writer read only the notes the planner named records only those (#474 idea 3).
  const read = (pageId: string): Record<string, string> => {
    const ids = states.pageNotes?.[pageId];
    if (!ids) return { ...states.notes };
    return Object.fromEntries(ids.flatMap(id => states.notes[id] === undefined ? [] : [[id, states.notes[id]!] as const]));
  };
  return [...new Set(states.written)].map(pageId => ({ pageId,
    notes: rewritten.has(pageId) ? { ...(prior.get(pageId)?.notes ?? {}), ...read(pageId) } : read(pageId) }));
}

/** Record what each written page was built from, in one transaction. */
export function writePageNoteStates(db: Database.Database, project: string, builtAt: string,
  pages: ReadonlyArray<{ pageId: string; notes: Readonly<Record<string, string>> }>): void {
  const write = db.prepare(`
    INSERT INTO wiki_page_note_states (page_id, project, built_at, notes_json) VALUES (?, ?, ?, ?)
    ON CONFLICT(page_id) DO UPDATE SET project = excluded.project, built_at = excluded.built_at, notes_json = excluded.notes_json
  `);
  db.transaction(() => { for (const page of pages) write.run(page.pageId, project, builtAt, JSON.stringify(page.notes)); })();
}

/**
 * Where a page's record holds `from` for the note, hold `to` instead: the link sweep's write, which
 * changed the note's content hash and not its text (#332). A record from before text hashes holds
 * the content hash, so without this the note would reach the page's next rewrite as changed.
 * Returns how many pages' records moved.
 */
export function carryPageNoteHash(db: Database.Database, nodeId: string, from: string, to: string): number {
  // The id is matched as text first, so only records that mention the note are parsed.
  const rows = db.prepare(`SELECT page_id, notes_json FROM wiki_page_note_states WHERE instr(notes_json, ?) > 0`)
    .all(JSON.stringify(nodeId)) as Array<{ page_id: string; notes_json: string }>;
  const update = db.prepare('UPDATE wiki_page_note_states SET notes_json = ? WHERE page_id = ?');
  let moved = 0;
  for (const row of rows) {
    let notes: Record<string, string>;
    try {
      notes = notesSchema.parse(JSON.parse(row.notes_json));
    } catch {
      continue;
    }
    if (notes[nodeId] !== from) continue;
    notes[nodeId] = to;
    update.run(JSON.stringify(notes), row.page_id);
    moved += 1;
  }
  return moved;
}

/** Forget a project's pages, as when its wiki is removed. */
export function deletePageNoteStates(db: Database.Database, project: string): void {
  db.prepare('DELETE FROM wiki_page_note_states WHERE project = ?').run(project);
}
