/**
 * #482: Engines before it read `types` more narrowly than a designated type key. An
 * unquoted `[[link]]` (YAML's nested list), a list item of that form, a number or a boolean
 * was no type, a quoted link kept its `|alias` (`project|Projects`), and a type held twice
 * failed the note's index. Now every key reads alike (`typeKeyValues`).
 *
 * The startup index skips a file that has not changed, so a note indexed the old way would
 * keep its old types until its file changed, and Engine's next save of it would write the
 * old types over the value. So, once, at the first start of an Engine that reads every key
 * alike, each note the startup index did not just read is checked: when the types its file
 * holds now read differently from the types stored for it, it is indexed again from the same
 * bytes, through the startup index's own path (`indexFile`). That path refuses no type (a
 * type without a schema included), refuses no note, and writes no file; it stores the
 * note's values as the watcher stores them (#510, #515): coerced, a required field's
 * default filled, and a value that fails validation not stored, its field keeping the
 * value stored for it, or none. The file changes only at the note's next save, which
 * renders its types as a list.
 */
import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { getMeta, setMeta } from '../db/meta.js';
import { parseFrontmatterMapping, typeKeyValues } from '../parser/frontmatter.js';
import { typeKey } from '../parser/type-key.js';
import { safeVaultPath } from '../pipeline/safe-path.js';
import { sha256 } from './hash.js';
import { indexFile } from './indexer.js';

export const TYPES_REREAD_META_KEY = 'type_key_values_reread_v1';

/** The edits-log event naming each note read again, with its types before and after. */
export const TYPES_REREAD_EVENT = 'types-reread';

export interface TypesReread {
  file_path: string;
  before: string[];
  after: string[];
}

/**
 * Read again, once, every note whose stored types differ from what its unchanged file now
 * reads as. `indexedSince` is when this start's index began: a note indexed since then was
 * read the new way already (on a new database, every note), so only older ones are checked.
 * Returns null when the check already ran on this database.
 */
export function rereadTypeKeyValues(
  vaultPath: string,
  db: Database.Database,
  indexedSince: number,
): TypesReread[] | null {
  if (getMeta(db, TYPES_REREAD_META_KEY) !== null) return null;
  const key = typeKey();
  const nodes = db.prepare(
    'SELECT id, file_path, content_hash FROM nodes WHERE indexed_at IS NULL OR indexed_at < ? ORDER BY file_path',
  ).all(indexedSince) as Array<{ id: string; file_path: string; content_hash: string | null }>;
  const storedTypes = db.prepare('SELECT schema_type FROM node_types WHERE node_id = ? ORDER BY sort_order, schema_type');
  const logEvent = db.prepare('INSERT INTO edits_log (node_id, timestamp, event_type, details) VALUES (?, ?, ?, ?)');

  const reread: TypesReread[] = [];
  for (const node of nodes) {
    let absolutePath: string;
    let content: string;
    try {
      absolutePath = safeVaultPath(vaultPath, node.file_path);
      content = readFileSync(absolutePath, 'utf-8');
    } catch {
      continue; // gone or unreadable: the watcher and the next index own it
    }
    // A file that changed since it was indexed is the watcher's; the bytes read here
    // must be the ones the stored note came from.
    if (sha256(content) !== node.content_hash) continue;
    const mapping = parseFrontmatterMapping(content);
    if (mapping.parseError !== null) continue;
    const after = Object.hasOwn(mapping.data, key) ? typeKeyValues(mapping.data[key]) : [];
    const before = (storedTypes.all(node.id) as Array<{ schema_type: string }>).map(row => row.schema_type);
    if (before.length === after.length && before.every((type, i) => type === after[i])) continue;

    try {
      indexFile(absolutePath, vaultPath, db);
    } catch (err) {
      // The same bytes indexed before, so this is not expected; the note keeps its stored
      // state, and its next file change indexes it the new way.
      console.warn(`[types] could not read ${node.file_path} again: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    logEvent.run(node.id, Date.now(), TYPES_REREAD_EVENT, JSON.stringify({ file_path: node.file_path, before, after }));
    reread.push({ file_path: node.file_path, before, after });
  }
  setMeta(db, TYPES_REREAD_META_KEY, new Date().toISOString());
  return reread;
}

/** At most this many notes are named in the start log; the edits log has every one. */
const LOGGED_NOTES = 50;

/** The start log's lines for a reread: none when nothing changed. */
export function typesRereadLog(reread: TypesReread[] | null): string[] {
  if (reread === null || reread.length === 0) return [];
  const list = (types: string[]) => types.length === 0 ? '(none)' : types.join(', ');
  return [
    `[types] ${reread.length} note(s) read again: their "${typeKey()}" value now reads as other types (#482). `
      + `Each is in the edits log as "${TYPES_REREAD_EVENT}"; its file changes only at its next save.`,
    ...reread.slice(0, LOGGED_NOTES).map(note => `[types]   ${note.file_path}: ${list(note.before)} -> ${list(note.after)}`),
    ...(reread.length > LOGGED_NOTES ? [`[types]   ... and ${reread.length - LOGGED_NOTES} more`] : []),
  ];
}
