import type Database from 'better-sqlite3';
import type { ProvenanceLimits } from './limits.js';
import { clearDerivation } from './purge.js';

export function runProvenanceRetention(db: Database.Database, limits: ProvenanceLimits, now = new Date()): { abandoned: number; expired: number } {
  return db.transaction(() => {
    const at = now.toISOString();
    const abandoned = db.prepare(`UPDATE provenance_derivations SET state='abandoned',terminal_at=lease_expires_at,reserved_remaining_bytes=0
      WHERE state IN ('prepared','result_staged') AND availability='retained' AND lease_expires_at<=?`).run(at).changes;
    const cutoff = new Date(now.getTime() - limits.failedRetentionDays * 86400000).toISOString();
    const rows = db.prepare(`SELECT id FROM provenance_derivations WHERE state IN ('failed','abandoned')
      AND availability='retained' AND terminal_at<=? ORDER BY terminal_at,id LIMIT 100`).all(cutoff) as Array<{ id: string }>;
    for (const row of rows) clearDerivation(db, row.id, 'expired', at);
    return { abandoned, expired: rows.length };
  }).immediate();
}
