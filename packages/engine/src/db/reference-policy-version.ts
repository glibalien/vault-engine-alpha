import Database from 'better-sqlite3';
import type { ReferencePolicyVersion } from '../resolver/relationship-policy.js';

export const REFERENCE_POLICY_VERSION_KEY = 'reference_resolution_policy_version';

/** Validate an existing marker without opening Engine's mutating startup connection. */
export function preflightReferencePolicyVersion(dbPath: string): void {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
    if (hasMeta) readReferencePolicyVersion(db);
  } finally {
    db.close();
  }
}

export function readReferencePolicyVersion(db: Database.Database): ReferencePolicyVersion {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(REFERENCE_POLICY_VERSION_KEY) as { value: string } | undefined;
  if (!row) return 1;
  if (row.value === '1' || row.value === '2') return Number(row.value) as ReferencePolicyVersion;
  throw new Error(`Unsupported reference resolution policy version: ${row.value}`);
}

export function initializeReferencePolicyVersion(db: Database.Database, databaseWasNew: boolean): void {
  db.transaction(() => {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(REFERENCE_POLICY_VERSION_KEY) as { value: string } | undefined;
    if (row) {
      readReferencePolicyVersion(db);
      return;
    }
    const empty = !db.prepare('SELECT 1 FROM nodes LIMIT 1').get();
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(REFERENCE_POLICY_VERSION_KEY, databaseWasNew && empty ? '2' : '1');
  })();
}
