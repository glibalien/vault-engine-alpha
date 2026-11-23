// src/auth/token-cleanup.ts
//
// Deletes expired oauth rows (DB-health Part B). Expiry semantics already
// live in the rows (unix seconds), so there are no knobs. Lives in src/auth/
// to respect the copy-forwarded module boundary; src/db/maintenance.ts just
// calls it. Spec: docs/superpowers/specs/2026-06-09-db-health-bundle-design.md

import type Database from 'better-sqlite3';

/** Expired tokens are kept this long for "which token was used when" forensics. */
const EXPIRED_TOKEN_GRACE_SECONDS = 7 * 86_400;

export interface TokenCleanupResult {
  codesDeleted: number;
  tokensDeleted: number;
}

export function runTokenCleanup(db: Database.Database): TokenCleanupResult {
  // oauth tables exist only once the HTTP transport has run createAuthSchema;
  // in stdio-only mode there is nothing to clean.
  const tableCount = (db.prepare(
    "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name IN ('oauth_codes', 'oauth_tokens')"
  ).get() as { c: number }).c;
  if (tableCount < 2) return { codesDeleted: 0, tokensDeleted: 0 };

  const now = Math.floor(Date.now() / 1000);
  const run = db.transaction((): TokenCleanupResult => {
    // Codes live 10 minutes and are single-use — any expired row is garbage.
    const codesDeleted = db.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').run(now).changes;

    // Delete once past the grace deadline: revoked rows get no grace, others
    // keep a 7-day forensic window after expiry. Service tokens (~100y expiry)
    // never match by construction.
    const tokensDeleted = db.prepare(
      'DELETE FROM oauth_tokens WHERE expires_at < CASE WHEN revoked = 1 THEN ? ELSE ? END'
    ).run(now, now - EXPIRED_TOKEN_GRACE_SECONDS).changes;

    return { codesDeleted, tokensDeleted };
  });
  return run();
}
