import type Database from 'better-sqlite3';

/**
 * The words of each note's search row, keyed by `<file path> <column>`, for one note or
 * all. `nodes_fts` keeps no content (its columns always read NULL), so the words are read
 * from its index (`fts5vocab`).
 */
export function searchWords(db: Database.Database, path?: string): Record<string, string> {
  db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS temp.search_words USING fts5vocab(main, nodes_fts, instance)');
  const rows = db.prepare(`SELECT n.file_path, w.col, group_concat(w.term, ' ') AS words FROM
    (SELECT doc, col, term FROM temp.search_words ORDER BY doc, col, offset) w
    JOIN nodes n ON n.rowid = w.doc WHERE ? IS NULL OR n.file_path = ? GROUP BY w.doc, w.col`)
    .all(path ?? null, path ?? null) as Array<{ file_path: string; col: string; words: string }>;
  return Object.fromEntries(rows.map(row => [`${row.file_path} ${row.col}`, row.words]));
}
