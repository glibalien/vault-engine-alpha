import type Database from 'better-sqlite3';
import { getMeta, setMeta } from './meta.js';
import { DEFAULT_TYPE_KEY, TypeKeyError } from '../parser/type-key.js';

/** Meta key recording the frontmatter key a database's notes were indexed with (#445). */
export const TYPE_KEY_META = 'frontmatter_type_key';

/**
 * The frontmatter key this database was built with: the recorded one, or, when none is
 * recorded, `types` for a database that already has notes (every Engine before #445 used
 * it) and `null` for one that has none yet.
 */
export function builtTypeKey(db: Database.Database): string | null {
  const recorded = getMeta(db, TYPE_KEY_META);
  if (recorded !== null) return recorded;
  return db.prepare('SELECT 1 FROM nodes LIMIT 1').get() ? DEFAULT_TYPE_KEY : null;
}

/**
 * Check the configured type key against the one the database was built with, and record
 * it. A different key would read every note as untyped and write the types of each saved
 * note under a second key, so Engine refuses to start instead (changing the key needs a
 * migration that rewrites every note, which does not exist yet). An existing database
 * with no recorded key was built with `types`: it starts normally with no VAULT_TYPE_KEY
 * (or `types`), and its key is recorded.
 */
export function checkTypeKey(db: Database.Database, configured: string): void {
  const built = builtTypeKey(db);
  if (built !== null && built !== configured) {
    throw new TypeKeyError(
      `VAULT_TYPE_KEY is "${configured}", but this database's notes were indexed with "${built}" `
      + `as the frontmatter key that holds a note's types. Engine will not start: with a different key `
      + `it would read every note as untyped. Set VAULT_TYPE_KEY=${built} (or remove it when that is `
      + `"${DEFAULT_TYPE_KEY}") and start Engine again. The key is chosen at install; changing it later `
      + `needs every note rewritten, which Engine cannot do yet.`,
    );
  }
  if (getMeta(db, TYPE_KEY_META) !== configured) setMeta(db, TYPE_KEY_META, configured);
}
